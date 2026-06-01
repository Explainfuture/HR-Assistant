import { SCORE_DIMENSIONS } from "./jsonUtils.js";

export function renderAnalysisReport({
  analysis,
  batchResults = [],
  fallbackProfileTitle = "未命名岗位",
  fallbackScore = null,
  fallbackRecommendation = "",
  copyableConclusion = "",
  includeCopyButton = false,
  onCopy,
  headingLevel = 2
} = {}) {
  const fragment = document.createDocumentFragment();
  const role = analysis?.matchedRole || {};

  fragment.append(
    section("匹配岗位", [
      scoreRow(role.matchScore ?? fallbackScore, role.recommendation || fallbackRecommendation),
      scoreBreakdownBlock(analysis?.scoreBreakdown),
      thresholdBlock(analysis?.thresholdChecks),
      paragraph(role.roleName || fallbackProfileTitle, "muted")
    ], headingLevel)
  );

  if (batchResults.length) {
    fragment.append(section("候选岗位评分", [rankingBlock(batchResults)], headingLevel));
  }

  const experience = analysis?.experienceAnalysis || {};
  fragment.append(
    section("经验分析", [
      paragraph(experience.oneLineProfile || "未返回一句话画像。"),
      listBlock("匹配项目", experience.matchedProjects, headingLevel + 1),
      listBlock("不匹配项目", experience.mismatchedProjects, headingLevel + 1),
      listBlock("疑似包装点", experience.overclaimRisks, headingLevel + 1),
      listBlock("高含金量信号", experience.highValueSignals, headingLevel + 1)
    ], headingLevel)
  );

  const objective = analysis?.objectiveAnalysis || {};
  fragment.append(
    section("客观分析", [
      objectBlock("学历", objective.education, headingLevel + 1),
      objectBlock("年龄/经验", objective.ageAndExperience, headingLevel + 1),
      objectBlock("离职状态", objective.employmentStatus, headingLevel + 1)
    ], headingLevel)
  );

  const elimination = analysis?.elimination || {};
  fragment.append(
    section("淘汰理由", [
      elimination.shouldReject
        ? listBlock("建议淘汰", elimination.reasons, headingLevel + 1)
        : paragraph("暂无硬性淘汰点。")
    ], headingLevel)
  );

  fragment.append(section("面试追问", [listBlock("", analysis?.interviewQuestions, headingLevel + 1)], headingLevel));

  const summaryChildren = [paragraph(copyableConclusion || "暂无可复制总结。")];
  if (includeCopyButton) {
    summaryChildren.push(copyButton(copyableConclusion, onCopy));
  }
  fragment.append(section("复制总结", summaryChildren, headingLevel));

  return fragment;
}

function section(title, children, headingLevel) {
  const node = document.createElement("section");
  node.className = "report-section";
  const heading = document.createElement(`h${Math.min(Math.max(headingLevel, 2), 4)}`);
  heading.textContent = title;
  node.append(heading, ...children.filter(Boolean));
  return node;
}

function scoreRow(score, recommendation) {
  const row = document.createElement("div");
  row.className = "score-row";

  const scoreNode = document.createElement("div");
  scoreNode.className = "score";
  scoreNode.textContent = Number.isFinite(Number(score)) ? `${Number(score)}` : "-";

  const recommendationNode = document.createElement("span");
  recommendationNode.className = "recommendation";
  recommendationNode.textContent = recommendation || "需要人工复核";

  row.append(scoreNode, recommendationNode);
  return row;
}

function scoreBreakdownBlock(scoreBreakdown) {
  if (!scoreBreakdown || typeof scoreBreakdown !== "object") return null;

  const rows = SCORE_DIMENSIONS.map((dimension) => {
    const item = scoreBreakdown[dimension.key];
    if (!item) return null;
    const maxScore = Number(item.maxScore ?? dimension.maxScore);
    const score = Number(item.score ?? 0);
    if (!Number.isFinite(maxScore) || maxScore <= 0) return null;

    const row = document.createElement("div");
    row.className = "score-breakdown-item";

    const header = document.createElement("div");
    header.className = "score-breakdown-header";

    const label = document.createElement("span");
    label.textContent = item.label || dimension.label;

    const value = document.createElement("span");
    value.textContent = [
      `${Number.isFinite(score) ? score : 0}/${maxScore}`,
      confidenceText(item.confidence)
    ].filter(Boolean).join(" · ");

    header.append(label, value);

    const meter = document.createElement("div");
    meter.className = "score-meter";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(0, Math.min(100, (score / maxScore) * 100))}%`;
    meter.append(fill);

    const reason = document.createElement("p");
    reason.className = "score-reason";
    reason.textContent = item.reason || "暂无得分说明";

    row.append(header, meter, reason, evidenceList(item.evidence));
    return row;
  }).filter(Boolean);

  if (!rows.length) return null;

  const node = document.createElement("div");
  node.className = "score-breakdown";
  node.append(...rows);
  return node;
}

function confidenceText(value) {
  if (value === "high") return "判断依据：充分";
  if (value === "medium") return "判断依据：一般";
  if (value === "low") return "判断依据：较弱";
  return "";
}

function evidenceList(evidence) {
  const items = Array.isArray(evidence)
    ? evidence.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
    : [];
  if (!items.length) return null;

  const list = document.createElement("ul");
  list.className = "score-evidence";

  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.append(li);
  }

  return list;
}

function thresholdBlock(thresholdChecks) {
  if (!thresholdChecks || typeof thresholdChecks !== "object") return null;
  const checks = [thresholdChecks.age, thresholdChecks.education].filter(Boolean);
  if (!checks.length) return null;

  const node = document.createElement("div");
  node.className = "threshold-grid";

  for (const check of checks) {
    const item = document.createElement("div");
    item.className = `threshold-item ${check.status || "unknown"}`;

    const label = document.createElement("span");
    label.className = "threshold-label";
    label.textContent = check.label || "门槛项";

    const status = document.createElement("span");
    status.className = "threshold-status";
    status.textContent = thresholdStatusText(check.status);

    const summary = document.createElement("p");
    summary.textContent = [check.summary, check.reason, check.followUp].filter(Boolean).join("；") || "简历未明确体现";

    item.append(label, status, summary);
    node.append(item);
  }

  return node;
}

function rankingBlock(results) {
  const sorted = [...results].sort((a, b) => {
    const aScore = getResultScore(a);
    const bScore = getResultScore(b);
    if ((a.error || "") && !(b.error || "")) return 1;
    if (!(a.error || "") && (b.error || "")) return -1;
    return bScore - aScore;
  });
  const list = document.createElement("ol");
  list.className = "ranking-list";

  for (const item of sorted) {
    const profile = item.profile || {};
    const score = item.analysis ? getMatchScore(item.analysis) : item.matchScore;
    const recommendation =
      item.analysis?.matchedRole?.recommendation || item.recommendation || item.error || "评估失败";

    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "ranking-title";
    title.textContent = profile.title || "未命名岗位";

    const meta = document.createElement("span");
    meta.className = "ranking-meta";
    meta.textContent = `${profile.category || "未分类"} · ${score ?? "-"} · ${recommendation}`;

    li.append(title, meta);
    list.append(li);
  }

  return list;
}

function listBlock(title, items, headingLevel) {
  const normalized = Array.isArray(items) ? items : [];
  const fragment = document.createDocumentFragment();

  if (title) {
    const heading = document.createElement(`h${Math.min(Math.max(headingLevel, 3), 4)}`);
    heading.textContent = title;
    fragment.append(heading);
  }

  if (!normalized.length) {
    fragment.append(paragraph("暂无", "empty"));
    return fragment;
  }

  const list = document.createElement("ul");
  list.className = "item-list";

  for (const item of normalized) {
    const li = document.createElement("li");
    if (typeof item === "string") {
      li.textContent = item;
    } else {
      li.append(renderObjectListItem(item));
    }
    list.append(li);
  }

  fragment.append(list);
  return fragment;
}

function renderObjectListItem(item) {
  const fragment = document.createDocumentFragment();
  const title =
    item.project ||
    item.claim ||
    item.requirement ||
    item.risk ||
    item.signal ||
    item.title ||
    item.name ||
    "条目";

  const titleNode = document.createElement("div");
  titleNode.className = "item-title";
  titleNode.textContent = String(title);
  fragment.append(titleNode);

  const detailParts = [
    item.reason,
    item.evidence,
    item.summary,
    item.description,
    item.strength ? `强度：${item.strength}` : "",
    item.valueLevel ? `含金量：${item.valueLevel}` : "",
    item.severity ? `严重度：${item.severity}` : ""
  ].filter(Boolean);

  if (detailParts.length) {
    const detailNode = document.createElement("div");
    detailNode.textContent = detailParts.join("；");
    fragment.append(detailNode);
    return fragment;
  }

  const fallback = Object.entries(item)
    .filter(([key]) => !["project", "claim", "requirement", "risk", "signal", "title", "name"].includes(key))
    .map(([key, value]) => `${key}: ${formatValue(value)}`)
    .join("；");

  if (fallback) {
    const fallbackNode = document.createElement("div");
    fallbackNode.textContent = fallback;
    fragment.append(fallbackNode);
  }

  return fragment;
}

function objectBlock(title, value, headingLevel) {
  const lines = [];
  if (value?.summary) lines.push(value.summary);
  if (value?.risk) lines.push(`风险：${value.risk}`);
  if (value?.followUp) lines.push(`追问：${value.followUp}`);

  return listBlock(title, lines.length ? lines : ["简历未明确体现"], headingLevel);
}

function paragraph(text, className = "") {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function copyButton(text, onCopy) {
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = "复制备注总结";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text || "");
    onCopy?.();
  });
  return button;
}

function thresholdStatusText(status) {
  if (status === "satisfied") return "满足";
  if (status === "unsatisfied") return "不满足";
  return "未明确";
}

function getResultScore(result) {
  return result.analysis ? getMatchScore(result.analysis) : Number(result.matchScore ?? -1);
}

function getMatchScore(analysis) {
  return Number(analysis?.matchedRole?.matchScore ?? 0);
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join("、");
  if (value && typeof value === "object") return Object.values(value).map(formatValue).join("、");
  return String(value ?? "");
}
