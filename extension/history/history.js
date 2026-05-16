import {
  clearAnalysisHistory,
  listAnalysisHistory,
  updateAnalysisHistoryEntry
} from "../shared/storage.js";
import { isCandidateNameRecognized } from "../shared/candidateUtils.js";

const historySummary = document.querySelector("#historySummary");
const candidateCount = document.querySelector("#candidateCount");
const historyList = document.querySelector("#historyList");
const detailTitle = document.querySelector("#detailTitle");
const detailMeta = document.querySelector("#detailMeta");
const reportRoot = document.querySelector("#reportRoot");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const renameCandidateButton = document.querySelector("#renameCandidateButton");
const copyConclusionButton = document.querySelector("#copyConclusionButton");

let historyEntries = [];
let selectedEntry = null;

init();

closeHistoryButton.addEventListener("click", () => {
  window.close();
  window.setTimeout(() => {
    if (history.length > 1) history.back();
  }, 120);
});

clearHistoryButton.addEventListener("click", async () => {
  if (!historyEntries.length) return;
  if (!confirm("确定清空所有候选人解析历史？此操作无法撤销。")) return;

  historyEntries = await clearAnalysisHistory();
  selectedEntry = null;
  render();
});

copyConclusionButton.addEventListener("click", async () => {
  if (!selectedEntry?.copyableConclusion) return;
  await navigator.clipboard.writeText(selectedEntry.copyableConclusion);
  copyConclusionButton.textContent = "已复制";
  window.setTimeout(() => {
    copyConclusionButton.textContent = "复制备注总结";
  }, 1400);
});

renameCandidateButton.addEventListener("click", async () => {
  if (!selectedEntry) return;
  const nextName = prompt("请输入候选人真实姓名", selectedEntry.candidateName || "");
  if (nextName == null) return;
  if (!isCandidateNameRecognized(nextName)) {
    alert("请输入 2-6 个中文字符的真实姓名，不要填写页面按钮文案。");
    return;
  }

  historyEntries = await updateAnalysisHistoryEntry(selectedEntry.id, {
    candidateName: nextName
  });
  selectedEntry = historyEntries.find((entry) => entry.id === selectedEntry.id) || historyEntries[0] || null;
  render();
});

async function init() {
  historyEntries = await listAnalysisHistory();
  selectedEntry = historyEntries[0] || null;
  render();
}

function render() {
  candidateCount.textContent = String(historyEntries.length);
  historySummary.textContent = historyEntries.length
    ? `本地保留最近 ${historyEntries.length} 位候选人的解析结果。`
    : "暂无本地候选人解析历史。";
  clearHistoryButton.disabled = !historyEntries.length;
  renderHistoryList();
  renderSelectedEntry();
}

function renderHistoryList() {
  historyList.innerHTML = "";

  if (!historyEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "暂无候选人历史。";
    historyList.append(empty);
    return;
  }

  for (const entry of historyEntries) {
    const button = document.createElement("button");
    button.className = "candidate-item";
    button.type = "button";
    button.setAttribute("aria-pressed", String(entry.id === selectedEntry?.id));
    button.addEventListener("click", () => {
      selectedEntry = entry;
      render();
    });

    const nameRow = document.createElement("span");
    nameRow.className = "candidate-name-row";

    const name = document.createElement("span");
    name.className = "candidate-name";
    name.textContent = entry.candidateName || "姓名未识别";

    const score = document.createElement("span");
    score.className = "candidate-score";
    score.textContent = Number.isFinite(Number(entry.matchScore)) ? `${Number(entry.matchScore)}` : "-";

    nameRow.append(name, score);

    const meta = document.createElement("span");
    meta.className = "candidate-meta";
    meta.textContent = [
      formatHistoryTime(entry.createdAt),
      entry.source,
      entry.profile?.category,
      entry.profile?.title
    ]
      .filter(Boolean)
      .join(" · ");

    const recommendation = document.createElement("span");
    recommendation.className = "candidate-recommendation";
    recommendation.textContent = entry.recommendation || "需要人工复核";

    button.append(nameRow, meta, recommendation);
    historyList.append(button);
  }
}

function renderSelectedEntry() {
  reportRoot.innerHTML = "";
  copyConclusionButton.disabled = !selectedEntry?.copyableConclusion;
  renameCandidateButton.disabled = !selectedEntry;

  if (!selectedEntry) {
    detailTitle.textContent = "解析详情";
    detailMeta.textContent = "选择一位候选人查看报告。";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "暂无可查看的解析报告。";
    reportRoot.append(empty);
    return;
  }

  detailTitle.textContent = selectedEntry.candidateName || "姓名未识别";
  detailMeta.textContent = [
    formatHistoryTime(selectedEntry.createdAt),
    selectedEntry.source,
    selectedEntry.profile?.category,
    selectedEntry.profile?.title,
    selectedEntry.recommendation
  ]
    .filter(Boolean)
    .join(" · ");

  renderReport(selectedEntry.analysis, selectedEntry.batchResults || []);
}

function renderReport(analysis, batchResults = []) {
  const role = analysis?.matchedRole || {};
  reportRoot.append(
    section("匹配岗位", [
      scoreRow(role.matchScore ?? selectedEntry?.matchScore, role.recommendation || selectedEntry?.recommendation),
      paragraph(role.roleName || selectedEntry?.profile?.title || "未命名岗位", "muted")
    ])
  );

  if (batchResults.length) {
    reportRoot.append(section("候选岗位评分", [rankingBlock(batchResults)]));
  }

  const experience = analysis?.experienceAnalysis || {};
  reportRoot.append(
    section("经验分析", [
      paragraph(experience.oneLineProfile || "未返回一句话画像。"),
      listBlock("匹配项目", experience.matchedProjects),
      listBlock("不匹配项目", experience.mismatchedProjects),
      listBlock("疑似包装点", experience.overclaimRisks),
      listBlock("高含金量信号", experience.highValueSignals)
    ])
  );

  const objective = analysis?.objectiveAnalysis || {};
  reportRoot.append(
    section("客观分析", [
      objectBlock("学历", objective.education),
      objectBlock("年龄/经验", objective.ageAndExperience),
      objectBlock("离职状态", objective.employmentStatus)
    ])
  );

  const elimination = analysis?.elimination || {};
  reportRoot.append(
    section("淘汰理由", [
      elimination.shouldReject
        ? listBlock("建议淘汰", elimination.reasons)
        : paragraph("暂无硬性淘汰点。")
    ])
  );

  reportRoot.append(section("面试追问", [listBlock("", analysis?.interviewQuestions)]));
  reportRoot.append(section("复制总结", [paragraph(selectedEntry.copyableConclusion || "暂无可复制总结。")]));
}

function section(title, children) {
  const node = document.createElement("section");
  node.className = "report-section";
  const heading = document.createElement("h3");
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

function rankingBlock(results) {
  const sorted = [...results].sort((a, b) => Number(b.matchScore ?? -1) - Number(a.matchScore ?? -1));
  const list = document.createElement("ol");
  list.className = "ranking-list";

  for (const item of sorted) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.className = "ranking-title";
    title.textContent = item.profile?.title || "未命名岗位";

    const meta = document.createElement("span");
    meta.className = "ranking-meta";
    meta.textContent = [
      item.profile?.category || "未分类",
      item.matchScore == null ? "-" : `${item.matchScore}`,
      item.recommendation || item.error || "评估失败"
    ].join(" · ");

    li.append(title, meta);
    list.append(li);
  }

  return list;
}

function listBlock(title, items) {
  const normalized = Array.isArray(items) ? items : [];
  const fragment = document.createDocumentFragment();

  if (title) {
    const heading = document.createElement("h4");
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
    item.valueLevel ? `含金量：${item.valueLevel}` : ""
  ].filter(Boolean);

  if (detailParts.length) {
    const detailNode = document.createElement("div");
    detailNode.textContent = detailParts.join("；");
    fragment.append(detailNode);
  }

  return fragment;
}

function objectBlock(title, value) {
  const lines = [];
  if (value?.summary) lines.push(value.summary);
  if (value?.risk) lines.push(`风险：${value.risk}`);
  if (value?.followUp) lines.push(`追问：${value.followUp}`);

  return listBlock(title, lines.length ? lines : ["简历未明确体现"]);
}

function paragraph(text, className = "") {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function formatHistoryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
