import { extractTextFromPdfFile } from "../shared/pdfTextExtractor.js";
import { inferCandidateName } from "../shared/candidateUtils.js";
import { JOB_CATEGORIES } from "../shared/jsonUtils.js";
import {
  getSettings,
  listAnalysisHistory,
  listJobProfiles
} from "../shared/storage.js";

const categorySelect = document.querySelector("#categorySelect");
const profileSelect = document.querySelector("#profileSelect");
const autoMatchBossButton = document.querySelector("#autoMatchBossButton");
const analyzeBossButton = document.querySelector("#analyzeBossButton");
const autoMatchPdfButton = document.querySelector("#autoMatchPdfButton");
const analyzePdfButton = document.querySelector("#analyzePdfButton");
const reanalyzeLastButton = document.querySelector("#reanalyzeLastButton");
const pdfInput = document.querySelector("#pdfInput");
const refreshButton = document.querySelector("#refreshButton");
const historyButton = document.querySelector("#historyButton");
const openOptionsButton = document.querySelector("#openOptionsButton");
const statusText = document.querySelector("#statusText");
const captureBlock = document.querySelector("#captureBlock");
const captureSummary = document.querySelector("#captureSummary");
const taskList = document.querySelector("#taskList");
const reportRoot = document.querySelector("#reportRoot");
const actionButtons = [
  autoMatchBossButton,
  analyzeBossButton,
  autoMatchPdfButton,
  analyzePdfButton,
  reanalyzeLastButton
];

let settings = null;
let profiles = [];
let historyEntries = [];
let lastConclusion = "";
let lastResume = null;
let taskPollTimer = 0;

init();

refreshButton.addEventListener("click", async () => {
  await refreshLocalState();
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

historyButton.addEventListener("click", async () => {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("history/history.html")
  });
});

categorySelect.addEventListener("change", () => {
  renderProfileOptions();
});

autoMatchBossButton.addEventListener("click", async () => {
  await submitAnalysisTask({
    mode: "auto",
    busyButton: autoMatchBossButton,
    busyLabel: "提交中…",
    idleLabel: "自动判断适合哪个岗位",
    getResumeText: getBossResumeText
  });
});

analyzeBossButton.addEventListener("click", async () => {
  await submitAnalysisTask({
    mode: "single",
    busyButton: analyzeBossButton,
    busyLabel: "提交中…",
    idleLabel: "按上方指定岗位评估",
    getResumeText: getBossResumeText
  });
});

autoMatchPdfButton.addEventListener("click", async () => {
  await submitAnalysisTask({
    mode: "auto",
    busyButton: autoMatchPdfButton,
    busyLabel: "提交中…",
    idleLabel: "自动判断适合哪个岗位",
    getResumeText: getPdfResumeText
  });
});

analyzePdfButton.addEventListener("click", async () => {
  await submitAnalysisTask({
    mode: "single",
    busyButton: analyzePdfButton,
    busyLabel: "提交中…",
    idleLabel: "按上方指定岗位评估",
    getResumeText: getPdfResumeText
  });
});

reanalyzeLastButton.addEventListener("click", async () => {
  await submitAnalysisTask({
    mode: "single",
    busyButton: reanalyzeLastButton,
    busyLabel: "提交中…",
    idleLabel: "复用上次简历，按指定岗位再评估",
    getResumeText: async () => {
      if (!lastResume?.text) throw new Error("请先抓取 BOSS 页面或上传 PDF 简历");
      return lastResume;
    }
  });
});

async function init() {
  await refreshLocalState({ silent: true });
  await refreshTasks();
  startTaskPolling();
}

async function refreshLocalState({ silent = false } = {}) {
  settings = await getSettings();
  profiles = await listJobProfiles();
  historyEntries = await listAnalysisHistory();

  const selectedCategory = categorySelect.value;
  const selectedProfileId = profileSelect.value;
  renderCategoryOptions();
  if ([...categorySelect.options].some((option) => option.value === selectedCategory)) {
    categorySelect.value = selectedCategory;
  }
  renderProfileOptions();
  if ([...profileSelect.options].some((option) => option.value === selectedProfileId)) {
    profileSelect.value = selectedProfileId;
  }
  renderHistoryButton();

  if (!settings.apiKey) {
    setStatus("请先打开设置填写 DeepSeek API Key");
  } else if (!profiles.length) {
    setStatus("请先在设置中新增岗位知识库");
  } else if (!silent) {
    setStatus("岗位列表已刷新", "success");
  } else {
    setStatus("打开候选人简历后提交后台解析任务");
  }
}

async function getBossResumeText() {
  setStatus("正在抓取 BOSS 候选人弹层文本…");
  const extraction = await extractResumeFromActiveTab();
  if (!extraction?.ok) {
    throw new Error(extraction?.error || "简历采集失败");
  }
  if (!extraction.text || extraction.text.length < 80) {
    throw new Error("采集到的简历文本过短，请确认已打开候选人简历弹层");
  }
  return {
    source: "BOSS 页面",
    candidateName: extraction.candidateName,
    text: extraction.text,
    summary: `${extraction.candidateName || "姓名未识别"} · 已采集 ${extraction.text.length} 个字符`
  };
}

async function getPdfResumeText() {
  const file = pdfInput.files?.[0];
  if (!file) throw new Error("请先选择 PDF 简历文件");

  setStatus("正在解析 PDF 简历文本…");
  const extraction = await extractTextFromPdfFile(file);
  const candidateName = inferCandidateName(extraction.text, file.name);
  return {
    source: "PDF 简历",
    candidateName,
    fallbackName: file.name,
    text: extraction.text,
    summary: `${candidateName} · 已提取 ${extraction.text.length} 个字符 · ${extraction.pageCount} 页`
  };
}

async function submitAnalysisTask({ mode, busyButton, busyLabel, idleLabel, getResumeText }) {
  try {
    setBusy(busyButton, true, busyLabel);
    reportRoot.hidden = true;

    settings = await getSettings();
    if (!settings.apiKey) throw new Error("请先在 Options 页面配置 DeepSeek API Key");
    if (!profiles.length) throw new Error("请先在设置中新增岗位知识库");

    const profile = mode === "single" ? getSelectedProfile() : null;
    if (mode === "single" && !profile) throw new Error("请先选择一个岗位知识库");

    const resume = await getResumeText();
    lastResume = resume;
    reanalyzeLastButton.disabled = false;
    captureSummary.textContent = resume.summary;
    captureBlock.hidden = false;

    const response = await chrome.runtime.sendMessage({
      type: "RESUME_COPILOT_SUBMIT_ANALYSIS_TASK",
      payload: {
        mode,
        category: categorySelect.value,
        profileId: profile?.id || "",
        resume
      }
    });
    if (!response?.ok) throw new Error(response?.error || "后台任务提交失败");

    setStatus(`${response.task.candidateName} 已提交后台解析，可继续打开下一个简历`, "success");
    await refreshTasks();
  } catch (error) {
    setStatus(error.message || String(error), "error");
  } finally {
    setBusy(busyButton, false, idleLabel);
  }
}

function getSelectedProfile() {
  return profiles.find((item) => item.id === profileSelect.value);
}

function getFilteredProfiles() {
  const category = categorySelect.value;
  return category ? profiles.filter((profile) => profile.category === category) : profiles;
}

function getMatchScore(analysis) {
  return Number(analysis?.matchedRole?.matchScore ?? 0);
}

function renderCategoryOptions() {
  categorySelect.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = `全部大类 (${profiles.length})`;
  categorySelect.append(allOption);

  for (const category of JOB_CATEGORIES) {
    const option = document.createElement("option");
    const count = profiles.filter((profile) => profile.category === category).length;
    option.value = category;
    option.textContent = `${category} (${count})`;
    categorySelect.append(option);
  }
}

function renderProfileOptions() {
  profileSelect.innerHTML = "";
  const filteredProfiles = getFilteredProfiles();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = filteredProfiles.length ? "选择岗位" : "当前大类暂无岗位";
  profileSelect.append(placeholder);

  for (const profile of filteredProfiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.title || "未命名岗位"} · ${profile.category || "未分类"}`;
    profileSelect.append(option);
  }
}

async function refreshTasks() {
  const response = await chrome.runtime.sendMessage({
    type: "RESUME_COPILOT_LIST_ANALYSIS_TASKS"
  });
  if (!response?.ok) return;

  renderTasks(response.tasks || []);

  if ((response.tasks || []).some((task) => task.status === "done")) {
    historyEntries = await listAnalysisHistory();
    renderHistoryButton();
  }
}

function startTaskPolling() {
  if (taskPollTimer) window.clearInterval(taskPollTimer);
  taskPollTimer = window.setInterval(refreshTasks, 2500);
}

function renderTasks(tasks) {
  taskList.innerHTML = "";

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无后台任务";
    taskList.append(empty);
    return;
  }

  for (const task of tasks.slice(0, 8)) {
    taskList.append(taskItem(task));
  }
}

function taskItem(task) {
  const item = document.createElement("article");
  item.className = `task-item ${task.status}`;

  const titleRow = document.createElement("div");
  titleRow.className = "task-title";

  const title = document.createElement("span");
  title.textContent = task.candidateName || "姓名未识别";

  const status = document.createElement("span");
  status.className = "task-status";
  status.textContent = taskStatusText(task);

  titleRow.append(title, status);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  meta.textContent = [
    task.source,
    task.profileCategory,
    task.profileTitle,
    task.recommendation,
    task.matchScore == null ? "" : `${task.matchScore} 分`
  ]
    .filter(Boolean)
    .join(" · ");

  item.append(titleRow, meta);

  if (task.error) {
    const error = document.createElement("div");
    error.className = "task-error";
    error.textContent = task.error;
    item.append(error);
  }

  return item;
}

function taskStatusText(task) {
  if (task.status === "queued") return "排队中";
  if (task.status === "running") {
    const { finished = 0, total = 0 } = task.progress || {};
    return total ? `处理中 ${finished}/${total}` : "处理中";
  }
  if (task.status === "done") return "已完成";
  return "失败";
}

function renderHistoryButton() {
  historyButton.textContent = `历史 ${historyEntries.length}`;
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

function renderReport(analysis, batchResults = []) {
  reportRoot.innerHTML = "";
  reportRoot.hidden = false;
  lastConclusion = analysis?.copyableConclusion || "";

  const role = analysis?.matchedRole || {};
  reportRoot.append(
    section("匹配岗位", [
      scoreRow(role.matchScore, role.recommendation),
      textBlock(role.roleName || "未命名岗位")
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

  reportRoot.append(
    section("复制总结", [
      paragraph(lastConclusion || "暂无可复制总结。"),
      copyButton()
    ])
  );
}

function rankingBlock(results) {
  const sorted = [...results].sort((a, b) => {
    const aScore = a.analysis ? getMatchScore(a.analysis) : Number(a.matchScore ?? -1);
    const bScore = b.analysis ? getMatchScore(b.analysis) : Number(b.matchScore ?? -1);
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
  for (const actionButton of actionButtons) {
    actionButton.disabled = busy || (actionButton === reanalyzeLastButton && !lastResume?.text);
  }
  button.textContent = label;
}
