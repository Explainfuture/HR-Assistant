import { analyzeCandidate } from "../shared/deepseekClient.js";
import { extractTextFromPdfFile } from "../shared/pdfTextExtractor.js";
import { getSettings, listJobProfiles } from "../shared/storage.js";

const profileSelect = document.querySelector("#profileSelect");
const analyzeBossButton = document.querySelector("#analyzeBossButton");
const analyzePdfButton = document.querySelector("#analyzePdfButton");
const pdfInput = document.querySelector("#pdfInput");
const openOptionsButton = document.querySelector("#openOptionsButton");
const statusText = document.querySelector("#statusText");
const captureBlock = document.querySelector("#captureBlock");
const captureSummary = document.querySelector("#captureSummary");
const reportRoot = document.querySelector("#reportRoot");

let settings = null;
let profiles = [];
let lastConclusion = "";

init();

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

analyzeBossButton.addEventListener("click", async () => {
  await runAnalysis({
    busyButton: analyzeBossButton,
    busyLabel: "抓取中…",
    idleLabel: "抓取 BOSS 页面并分析",
    getResumeText: async () => {
      setStatus("正在抓取 BOSS 候选人弹层文本…");
      const extraction = await extractResumeFromActiveTab();
      if (!extraction?.ok) {
        throw new Error(extraction?.error || "简历采集失败");
      }
      if (!extraction.text || extraction.text.length < 80) {
        throw new Error("采集到的简历文本过短，请确认已打开候选人简历弹层");
      }
      return {
        text: extraction.text,
        summary: `已采集 ${extraction.text.length} 个字符，展开 ${extraction.debug?.expandedClicks || 0} 次，滚动 ${extraction.debug?.scrollRounds || 0} 轮。`
      };
    }
  });
});

analyzePdfButton.addEventListener("click", async () => {
  await runAnalysis({
    busyButton: analyzePdfButton,
    busyLabel: "解析中…",
    idleLabel: "解析 PDF 并分析",
    getResumeText: async () => {
      const file = pdfInput.files?.[0];
      setStatus("正在解析 PDF 简历文本…");
      const extraction = await extractTextFromPdfFile(file);
      return {
        text: extraction.text,
        summary: `已从 PDF 提取 ${extraction.text.length} 个字符，共 ${extraction.pageCount} 页。`
      };
    }
  });
});

async function init() {
  settings = await getSettings();
  profiles = await listJobProfiles();
  renderProfileOptions();

  if (!settings.apiKey) {
    setStatus("请先打开设置填写 DeepSeek API Key");
  } else if (!profiles.length) {
    setStatus("请先在设置中新增岗位知识库");
  } else {
    setStatus("请选择岗位，然后抓取 BOSS 页面或上传 PDF 分析");
  }
}

async function runAnalysis({ busyButton, busyLabel, idleLabel, getResumeText }) {
  try {
    setBusy(busyButton, true, busyLabel);
    setStatus("正在检查配置…");
    reportRoot.hidden = true;
    captureBlock.hidden = true;

    settings = await getSettings();
    if (!settings.apiKey) throw new Error("请先在 Options 页面配置 DeepSeek API Key");

    const profile = profiles.find((item) => item.id === profileSelect.value);
    if (!profile) throw new Error("请先选择一个岗位知识库");

    const resume = await getResumeText();
    captureSummary.textContent = resume.summary;
    captureBlock.hidden = false;

    setStatus("正在调用 DeepSeek 生成分析…");
    const analysis = await analyzeCandidate({
      apiKey: settings.apiKey,
      model: settings.model,
      jobProfile: profile,
      resumeText: resume.text
    });

    renderReport(analysis);
    setStatus("分析完成", "success");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(busyButton, false, idleLabel);
  }
}

function renderProfileOptions() {
  profileSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "选择岗位" : "暂无岗位知识库";
  profileSelect.append(placeholder);

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.title || "未命名岗位";
    profileSelect.append(option);
  }
}

async function extractResumeFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");
  if (!tab.url?.includes("zhipin.com")) {
    throw new Error("请在 BOSS 直聘页面使用此插件，或改用 PDF 上传分析");
  }

  return await chrome.tabs.sendMessage(tab.id, {
    type: "RESUME_COPILOT_EXTRACT_RESUME"
  });
}

function renderReport(analysis) {
  reportRoot.innerHTML = "";
  reportRoot.hidden = false;
  lastConclusion = analysis.copyableConclusion || "";

  const role = analysis.matchedRole || {};
  reportRoot.append(
    section("匹配岗位", [
      scoreRow(role.matchScore, role.recommendation),
      textBlock(role.roleName || "未命名岗位")
    ])
  );

  const experience = analysis.experienceAnalysis || {};
  reportRoot.append(
    section("经验分析", [
      paragraph(experience.oneLineProfile || "未返回一句话画像。"),
      listBlock("匹配项目", experience.matchedProjects),
      listBlock("不匹配项目", experience.mismatchedProjects),
      listBlock("疑似包装点", experience.overclaimRisks),
      listBlock("高含金量信号", experience.highValueSignals)
    ])
  );

  const objective = analysis.objectiveAnalysis || {};
  reportRoot.append(
    section("客观分析", [
      objectBlock("学历", objective.education),
      objectBlock("年龄/经验", objective.ageAndExperience),
      objectBlock("离职状态", objective.employmentStatus)
    ])
  );

  const elimination = analysis.elimination || {};
  reportRoot.append(
    section("淘汰理由", [
      elimination.shouldReject
        ? listBlock("建议淘汰", elimination.reasons)
        : paragraph("暂无硬性淘汰点。")
    ])
  );

  reportRoot.append(section("面试追问", [listBlock("", analysis.interviewQuestions)]));

  reportRoot.append(
    section("复制总结", [
      paragraph(lastConclusion || "暂无可复制总结。"),
      copyButton()
    ])
  );
}

function section(title, children) {
  const node = document.createElement("section");
  node.className = "report-section";
  const heading = document.createElement("h2");
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

function textBlock(text) {
  const node = document.createElement("p");
  node.className = "muted";
  node.textContent = text;
  return node;
}

function paragraph(text) {
  const node = document.createElement("p");
  node.textContent = text;
  return node;
}

function listBlock(title, items) {
  const normalized = Array.isArray(items) ? items : [];
  const fragment = document.createDocumentFragment();

  if (title) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    fragment.append(heading);
  }

  if (!normalized.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无";
    fragment.append(empty);
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

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join("、");
  if (value && typeof value === "object") return Object.values(value).map(formatValue).join("、");
  return String(value ?? "");
}

function objectBlock(title, value) {
  const lines = [];
  if (value?.summary) lines.push(value.summary);
  if (value?.risk) lines.push(`风险：${value.risk}`);
  if (value?.followUp) lines.push(`追问：${value.followUp}`);

  return listBlock(title, lines.length ? lines : ["简历未明确体现"]);
}

function copyButton() {
  const button = document.createElement("button");
  button.className = "copy-button";
  button.type = "button";
  button.textContent = "复制备注总结";
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(lastConclusion);
    setStatus("总结已复制", "success");
  });
  return button;
}

function setStatus(message, type = "") {
  statusText.textContent = message;
  statusText.className = `status ${type}`.trim();
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}
