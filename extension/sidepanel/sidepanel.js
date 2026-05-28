import { extractTextFromPdfFile } from "../shared/pdfTextExtractor.js";
import { inferCandidateName } from "../shared/candidateUtils.js";
import { JOB_CATEGORIES } from "../shared/jsonUtils.js";
import { renderAnalysisReport } from "../shared/reportRenderer.js";
import { createResumeFingerprint } from "../shared/resumeFingerprint.js";
import { markEntered, updateWithTransition } from "../shared/viewTransitions.js";
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
const historySummary = document.querySelector("#historySummary");
const candidateCount = document.querySelector("#candidateCount");
const historyList = document.querySelector("#historyList");
const reportRoot = document.querySelector("#reportRoot");
const actionButtons = [
  autoMatchBossButton,
  analyzeBossButton,
  autoMatchPdfButton,
  analyzePdfButton,
  reanalyzeLastButton
];
const AUTO_CAPTURE_INTERVAL_MS = 2400;

let settings = null;
let profiles = [];
let historyEntries = [];
let selectedHistoryEntry = null;
let lastConclusion = "";
let lastResume = null;
let taskPollTimer = 0;
let autoCaptureTimer = 0;
let autoCaptureInFlight = false;
let lastAutoFingerprint = "";

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

chrome.tabs?.onActivated?.addListener(() => {
  lastAutoFingerprint = "";
  window.setTimeout(() => autoCaptureActiveResume(), 500);
});

chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSupportedResumePage(tab?.url)) return;
  lastAutoFingerprint = "";
  window.setTimeout(() => autoCaptureActiveResume(), 800);
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
      if (!lastResume?.text && !lastResume?.imageUrls?.length) throw new Error("请先抓取 BOSS/Moka 页面或上传 PDF 简历");
      return lastResume;
    }
  });
});

async function init() {
  await refreshLocalState({ silent: true });
  await refreshTasks();
  startTaskPolling();
  startAutoCapturePolling();
  window.setTimeout(() => autoCaptureActiveResume(), 600);
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
  syncSelectedHistoryEntry();
  renderHistoryButton();
  renderHistoryList();
  renderSelectedHistoryReport();

  if (!settings.apiKey) {
    setStatus("请先打开设置填写 Doubao API Key");
  } else if (!profiles.length) {
    setStatus("请先在设置中新增岗位知识库");
  } else if (!silent) {
    setStatus("岗位列表已刷新", "success");
  } else {
    setStatus("打开候选人简历后会自动提交后台解析任务");
  }
}

async function getBossResumeText() {
  setStatus("正在抓取当前网页候选人简历…");
  const extraction = await extractResumeFromActiveTab();
  if (!extraction?.ok) {
    throw new Error(extraction?.error || "简历采集失败");
  }
  const resume = buildResumeFromExtraction(extraction);
  if ((!resume.text || resume.text.length < 80) && !resume.imageUrls.length) {
    throw new Error("采集到的简历文本过短，请确认已打开候选人简历弹层");
  }
  return resume;
}

async function getPdfResumeText() {
  const file = pdfInput.files?.[0];
  if (!file) throw new Error("请先选择 PDF 简历文件");

  setStatus("正在解析 PDF 简历文本并渲染页面图片…");
  const extraction = await extractTextFromPdfFile(file);
  const candidateName = inferCandidateName(extraction.text, file.name);
  return {
    source: "PDF 简历",
    candidateName,
    fallbackName: file.name,
    text: extraction.text,
    imageUrls: extraction.imageUrls || [],
    summary: `${candidateName} · 已提取 ${extraction.text.length} 个字符 · ${extraction.pageCount} 页${(extraction.imageUrls || []).length ? ` · ${extraction.imageUrls.length} 页OCR图` : ""}`
  };
}

async function submitAnalysisTask({ mode, busyButton, busyLabel, idleLabel, getResumeText }) {
  try {
    setBusy(busyButton, true, busyLabel);

    settings = await getSettings();
    if (!settings.apiKey) throw new Error("请先在 Options 页面配置 Doubao API Key");
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
        resume,
        dedupe: mode === "auto"
      }
    });
    if (!response?.ok) throw new Error(response?.error || "后台任务提交失败");

    if (response.task?.deduped) {
      setStatus(`${response.task.candidateName} 已解析过，已跳过重复任务`, "success");
    } else {
      setStatus(`${response.task.candidateName} 已提交后台解析，可继续打开下一个简历`, "success");
    }
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
    syncSelectedHistoryEntry();
    renderHistoryButton();
    renderHistoryList();
    renderSelectedHistoryReport();
  }
}

function startTaskPolling() {
  if (taskPollTimer) window.clearInterval(taskPollTimer);
  taskPollTimer = window.setInterval(refreshTasks, 2500);
}

function startAutoCapturePolling() {
  if (autoCaptureTimer) window.clearInterval(autoCaptureTimer);
  autoCaptureTimer = window.setInterval(() => autoCaptureActiveResume(), AUTO_CAPTURE_INTERVAL_MS);
}

async function autoCaptureActiveResume() {
  if (autoCaptureInFlight || !settings?.apiKey || !profiles.length) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedResumePage(tab.url)) return;

  autoCaptureInFlight = true;
  try {
    const extraction = await extractResumeFromTab(tab);
    if (!extraction?.ok) return;

    const resume = buildResumeFromExtraction(extraction);
    if ((!resume.text || resume.text.length < 80) && !resume.imageUrls.length) return;

    const resumeFingerprint = createResumeFingerprint(resume);
    if (!resumeFingerprint || resumeFingerprint === lastAutoFingerprint) return;

    const response = await chrome.runtime.sendMessage({
      type: "RESUME_COPILOT_SUBMIT_ANALYSIS_TASK",
      payload: {
        mode: "auto",
        category: categorySelect.value,
        profileId: "",
        resume,
        resumeFingerprint,
        dedupe: true,
        autoTriggered: true
      }
    });
    if (!response?.ok) throw new Error(response?.error || "后台任务提交失败");

    lastAutoFingerprint = resumeFingerprint;
    lastResume = resume;
    reanalyzeLastButton.disabled = false;
    captureSummary.textContent = resume.summary;
    captureBlock.hidden = false;

    if (response.task?.deduped) {
      setStatus(`${response.task.candidateName} 已解析过，自动跳过`, "success");
    } else {
      setStatus(`${response.task.candidateName} 已自动提交后台解析`, "success");
    }
    await refreshTasks();
  } catch (error) {
    if (!isSilentAutoCaptureError(error)) {
      setStatus(error.message || String(error), "error");
    }
  } finally {
    autoCaptureInFlight = false;
  }
}

function isSilentAutoCaptureError(error) {
  return /未检测到候选人|文本过短|Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(
    error?.message || String(error)
  );
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
    error.textContent = task.errorType ? `${task.errorType} · ${task.error}` : task.error;
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

function syncSelectedHistoryEntry() {
  if (selectedHistoryEntry) {
    selectedHistoryEntry = historyEntries.find((entry) => entry.id === selectedHistoryEntry.id) || null;
  }
  if (!selectedHistoryEntry) {
    selectedHistoryEntry = historyEntries[0] || null;
  }
}

function renderHistoryList() {
  candidateCount.textContent = String(historyEntries.length);
  historySummary.textContent = historyEntries.length
    ? `最近 ${historyEntries.length} 位候选人的解析结果`
    : "打开候选人简历后会自动进入这里";
  historyList.innerHTML = "";

  if (!historyEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无候选人历史";
    historyList.append(empty);
    return;
  }

  for (const entry of historyEntries) {
    const button = document.createElement("button");
    button.className = "candidate-item";
    button.type = "button";
    button.setAttribute("aria-pressed", String(entry.id === selectedHistoryEntry?.id));
    button.addEventListener("click", () => {
      selectedHistoryEntry = entry;
      renderHistoryList();
      renderSelectedHistoryReport();
    });

    const nameRow = document.createElement("span");
    nameRow.className = "candidate-name-row";

    const name = document.createElement("span");
    name.className = "candidate-name";
    name.textContent = entry.candidateName || "姓名未识别";

    const score = document.createElement("span");
    score.className = "candidate-score";
    score.textContent = Number.isFinite(Number(entry.matchScore)) ? `${Number(entry.matchScore)}` : "-";

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

    nameRow.append(name, score);
    button.append(nameRow, meta, recommendation);
    historyList.append(button);
  }
}

function renderHistoryButton() {
  historyButton.textContent = `历史页 ${historyEntries.length}`;
}

async function extractResumeFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("无法获取当前标签页");
  if (!isSupportedResumePage(tab.url)) {
    throw new Error("请在 BOSS 或 Moka 简历页面使用此插件，或改用 PDF 上传分析");
  }

  return extractResumeFromTab(tab);
}

async function extractResumeFromTab(tab) {
  const extraction = await chrome.tabs.sendMessage(tab.id, {
    type: "RESUME_COPILOT_EXTRACT_RESUME"
  });
  return {
    ...extraction,
    source: getSourceLabelForUrl(tab.url)
  };
}

function buildResumeFromExtraction(extraction) {
  const imageUrls = extraction.imageUrls || [];
  const text = String(extraction.text || "");
  return {
    source: extraction.source || "网页简历",
    candidateName: extraction.candidateName,
    text,
    imageUrls,
    summary: `${extraction.candidateName || "姓名未识别"} · 已采集 ${text.length} 个字符${imageUrls.length ? ` · ${imageUrls.length} 张简历图` : ""}`
  };
}

function isSupportedResumePage(url) {
  return /(?:^|\/\/|\.)(zhipin\.com|mokahr\.com|mokahr\.com\.cn)\//i.test(String(url || ""));
}

function getSourceLabelForUrl(url) {
  if (/mokahr/i.test(String(url || ""))) return "Moka 页面";
  if (/zhipin/i.test(String(url || ""))) return "BOSS 页面";
  return "网页简历";
}

function renderSelectedHistoryReport() {
  reportRoot.innerHTML = "";
  if (!selectedHistoryEntry) {
    reportRoot.hidden = true;
    return;
  }

  const analysis = selectedHistoryEntry.analysis;
  const batchResults = selectedHistoryEntry.batchResults || [];
  lastConclusion = selectedHistoryEntry.copyableConclusion || analysis?.copyableConclusion || "";
  updateWithTransition(() => {
    reportRoot.innerHTML = "";
    reportRoot.hidden = false;
    reportRoot.append(renderHistoryDetailHeader(selectedHistoryEntry));
    reportRoot.append(
      renderAnalysisReport({
        analysis,
        batchResults,
        fallbackProfileTitle: selectedHistoryEntry.profile?.title || "未命名岗位",
        fallbackScore: selectedHistoryEntry.matchScore,
        fallbackRecommendation: selectedHistoryEntry.recommendation,
        copyableConclusion: lastConclusion,
        includeCopyButton: true,
        onCopy: () => setStatus("总结已复制", "success"),
        headingLevel: 2
      })
    );
  });
  markEntered(reportRoot);
}

function renderHistoryDetailHeader(entry) {
  const header = document.createElement("div");
  header.className = "selected-history-header";

  const title = document.createElement("h2");
  title.textContent = entry.candidateName || "姓名未识别";

  const meta = document.createElement("p");
  meta.textContent = [
    formatHistoryTime(entry.createdAt),
    entry.source,
    entry.profile?.category,
    entry.profile?.title,
    entry.recommendation
  ]
    .filter(Boolean)
    .join(" · ");

  header.append(title, meta);
  return header;
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

function setStatus(message, type = "") {
  statusText.textContent = message;
  statusText.className = `status ${type}`.trim();
}

function setBusy(button, busy, label) {
  for (const actionButton of actionButtons) {
    actionButton.disabled = busy || (actionButton === reanalyzeLastButton && !lastResume?.text && !lastResume?.imageUrls?.length);
  }
  button.textContent = label;
}
