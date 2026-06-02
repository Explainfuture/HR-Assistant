import { extractTextFromPdfFile } from "../shared/pdfTextExtractor.js";
import { inferCandidateName } from "../shared/candidateUtils.js";
import { JOB_CATEGORIES } from "../shared/jsonUtils.js";
import {
  getMokaApplicationId,
  getMokaDetailUrl,
  getResumePageKey,
  isSupportedResumePage
} from "../shared/pagePolicy.js";
import { renderAnalysisReport } from "../shared/reportRenderer.js";
import { createResumeFingerprint } from "../shared/resumeFingerprint.js";
import { markEntered, updateWithTransition } from "../shared/viewTransitions.js";
import {
  getSettings,
  listAnalysisHistory,
  listJobProfiles,
  updateAnalysisHistoryEntry
} from "../shared/storage.js";

const categorySelect = document.querySelector("#categorySelect");
const profileSelect = document.querySelector("#profileSelect");
const autoMatchBossButton = document.querySelector("#autoMatchBossButton");
const analyzeBossButton = document.querySelector("#analyzeBossButton");
const autoMatchPdfButton = document.querySelector("#autoMatchPdfButton");
const analyzePdfButton = document.querySelector("#analyzePdfButton");
const reanalyzeLastButton = document.querySelector("#reanalyzeLastButton");
const pdfInput = document.querySelector("#pdfInput");
const pdfFileStatus = document.querySelector("#pdfFileStatus");
const refreshButton = document.querySelector("#refreshButton");
const historyButton = document.querySelector("#historyButton");
const openOptionsButton = document.querySelector("#openOptionsButton");
const statusText = document.querySelector("#statusText");
const queueStatusText = document.querySelector("#queueStatusText");
const historySummary = document.querySelector("#historySummary");
const candidateCount = document.querySelector("#candidateCount");
const historyList = document.querySelector("#historyList");
const historyPrevButton = document.querySelector("#historyPrevButton");
const historyPageInfo = document.querySelector("#historyPageInfo");
const historyNextButton = document.querySelector("#historyNextButton");
const reportRoot = document.querySelector("#reportRoot");
const actionButtons = [
  autoMatchBossButton,
  analyzeBossButton,
  autoMatchPdfButton,
  analyzePdfButton,
  reanalyzeLastButton
];
const AUTO_CAPTURE_INTERVAL_MS = 2400;
const AUTO_CAPTURE_TIMEOUT_MS = 15000;
const HISTORY_PAGE_SIZE = 10;

let settings = null;
let profiles = [];
let historyEntries = [];
let selectedHistoryEntry = null;
let historyPage = 1;
let lastConclusion = "";
let lastResume = null;
let taskPollTimer = 0;
let autoCaptureTimer = 0;
let autoCaptureInFlight = false;
let autoCaptureRerunRequested = false;
let lastAutoFingerprint = "";
let lastAutoPageKey = "";
let lastTaskSignature = "";
let lastHistorySignature = "";
let lastRenderedReportSignature = "";

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

historyPrevButton.addEventListener("click", () => {
  goToHistoryPage(historyPage - 1);
});

historyNextButton.addEventListener("click", () => {
  goToHistoryPage(historyPage + 1);
});

pdfInput.addEventListener("change", () => {
  renderPdfFileSelectionStatus();
});

chrome.tabs?.onActivated?.addListener(() => {
  lastAutoFingerprint = "";
  lastAutoPageKey = "";
  window.setTimeout(() => autoCaptureActiveResume(), 500);
});

chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isSupportedResumePage(tab?.url)) return;
  lastAutoFingerprint = "";
  lastAutoPageKey = "";
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
  lastHistorySignature = createHistorySignature(historyEntries);
  renderHistoryButton();
  renderHistoryList();
  renderSelectedHistoryReport({ force: true });

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

function renderPdfFileSelectionStatus() {
  const file = pdfInput.files?.[0];
  if (!file) {
    pdfFileStatus.textContent = "未选择 PDF 文件";
    pdfFileStatus.className = "file-status";
    return;
  }

  pdfFileStatus.textContent = `${file.name} 已上传`;
  pdfFileStatus.className = "file-status success";
  setStatus(`${file.name} 已上传`, "success");
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
      await refreshHistoryFromStorage({ force: true });
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

  const tasks = response.tasks || [];
  const taskSignature = createTaskSignature(tasks);
  const tasksChanged = taskSignature !== lastTaskSignature;

  if (tasksChanged) {
    lastTaskSignature = taskSignature;
    renderQueueStatus(tasks);
  }

  if (tasksChanged && tasks.some((task) => task.status === "done")) {
    await refreshHistoryFromStorage();
  }
}

async function refreshHistoryFromStorage({ force = false } = {}) {
  const nextHistory = await listAnalysisHistory();
  const nextHistorySignature = createHistorySignature(nextHistory);
  const previousSelectedId = selectedHistoryEntry?.id || "";

  historyEntries = nextHistory;
  syncSelectedHistoryEntry();

  const selectedChanged = previousSelectedId !== (selectedHistoryEntry?.id || "");
  if (!force && !selectedChanged && nextHistorySignature === lastHistorySignature) return;

  lastHistorySignature = nextHistorySignature;
  renderHistoryButton();
  renderHistoryList();
  renderSelectedHistoryReport({ force: selectedChanged });
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
  if (autoCaptureInFlight) {
    autoCaptureRerunRequested = true;
    return;
  }
  if (!settings?.apiKey || !profiles.length) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedResumePage(tab.url)) return;

  const pageKey = getResumePageKey(tab.url);
  if (lastAutoFingerprint && pageKey && pageKey === lastAutoPageKey) return;

  autoCaptureInFlight = true;
  try {
    setQueueInlineStatus("正在采集当前简历图片");
    setStatus("正在采集当前候选人简历图片…");

    const extraction = await withTimeout(
      extractResumeFromTab(tab),
      AUTO_CAPTURE_TIMEOUT_MS,
      "简历采集超时，请稍后重试"
    );
    if (!extraction?.ok) return;

    const resume = buildResumeFromExtraction(extraction);
    if ((!resume.text || resume.text.length < 80) && !resume.imageUrls.length) return;

    const resumeFingerprint = createResumeFingerprint(resume);
    if (!resumeFingerprint) return;
    if (resumeFingerprint === lastAutoFingerprint) {
      if (pageKey) lastAutoPageKey = pageKey;
      setQueueInlineStatus(`${resume.candidateName || "候选人"}已解析过，自动跳过`);
      return;
    }

    const candidateName = resume.candidateName || "候选人";
    setQueueInlineStatus(`${candidateName}正在提交后台解析`);
    setStatus(`${candidateName} 已采集，正在提交后台解析…`);

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
    if (pageKey) lastAutoPageKey = pageKey;
    lastResume = resume;
    reanalyzeLastButton.disabled = false;

    if (response.task?.deduped) {
      await refreshHistoryFromStorage({ force: true });
      setStatus(`${response.task.candidateName} 已解析过，自动跳过`, "success");
    } else {
      setStatus(`${response.task.candidateName} 已自动提交后台解析`, "success");
    }
    await refreshTasks();
  } catch (error) {
    if (isSilentAutoCaptureError(error)) {
      setQueueInlineStatus("等待简历图片加载");
    } else {
      setStatus(error.message || String(error), "error");
      setQueueInlineStatus("等待候选人详情");
    }
  } finally {
    autoCaptureInFlight = false;
    if (autoCaptureRerunRequested) {
      autoCaptureRerunRequested = false;
      window.setTimeout(() => autoCaptureActiveResume(), 120);
    }
  }
}

function isSilentAutoCaptureError(error) {
  return /未检测到候选人|文本过短|图片还未加载|Receiving end does not exist|Could not establish connection|Extension context invalidated/i.test(
    error?.message || String(error)
  );
}

function renderQueueStatus(tasks) {
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const queuedCount = tasks.filter((task) => task.status === "queued").length;
  const activeTask =
    tasks.find((task) => task.status === "running") ||
    tasks.find((task) => task.status === "queued") ||
    tasks.find((task) => task.status === "done") ||
    tasks.find((task) => task.status === "error");
  const queueSummary = runningCount || queuedCount ? `运行 ${runningCount}，排队 ${queuedCount}` : "";
  setQueueInlineStatus([
    activeTask ? taskStatusText(activeTask) : "等待候选人详情",
    queueSummary
  ].filter(Boolean).join(" · "));
}

function setQueueInlineStatus(message) {
  queueStatusText.textContent = `候选人后台解析队列 · ${message}`;
}

function taskStatusText(task) {
  const name = task.candidateName || "候选人";
  if (task.status === "queued") return `${name}排队中`;
  if (task.status === "running") {
    const { finished = 0, total = 0, stage = "", ocrFinished = 0, ocrTotal = 0 } = task.progress || {};
    if (stage === "ocr") {
      return ocrTotal
        ? `${name}正在识别简历图片 ${ocrFinished}/${ocrTotal}`
        : `${name}正在识别简历图片`;
    }
    return total ? `${name}正在处理 ${finished}/${total}` : `${name}正在处理`;
  }
  if (task.status === "done") return `${name}解析完成`;
  return `${name}解析失败`;
}

function syncSelectedHistoryEntry() {
  if (selectedHistoryEntry) {
    selectedHistoryEntry = historyEntries.find((entry) => entry.id === selectedHistoryEntry.id) || null;
  }
  if (!selectedHistoryEntry) {
    selectedHistoryEntry = historyEntries[0] || null;
  }
  syncHistoryPageToSelected();
}

function renderHistoryList() {
  historyPage = clampHistoryPage(historyPage);
  const totalPages = getHistoryPageCount();
  const pageEntries = getCurrentHistoryPageEntries();

  candidateCount.textContent = String(historyEntries.length);
  historySummary.textContent = historyEntries.length
    ? `第 ${historyPage}/${totalPages} 页 · 共 ${historyEntries.length} 位候选人`
    : "打开候选人简历后会自动进入这里";
  historyPageInfo.textContent = `${historyPage} / ${totalPages}`;
  historyPrevButton.disabled = historyPage <= 1;
  historyNextButton.disabled = historyPage >= totalPages;
  historyList.innerHTML = "";

  if (!historyEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "暂无候选人历史";
    historyList.append(empty);
    return;
  }

  for (const entry of pageEntries) {
    const button = document.createElement("button");
    button.className = "candidate-item";
    button.type = "button";
    button.setAttribute("aria-pressed", String(entry.id === selectedHistoryEntry?.id));
    button.addEventListener("click", () => {
      selectedHistoryEntry = entry;
      syncHistoryPageToSelected();
      renderHistoryList();
      renderSelectedHistoryReport();
      syncMokaCandidatePage(entry);
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
      entry.mokaPositionTitle,
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

function goToHistoryPage(page) {
  historyPage = clampHistoryPage(page);
  selectedHistoryEntry = getCurrentHistoryPageEntries()[0] || null;
  renderHistoryList();
  renderSelectedHistoryReport({ force: true });
}

function syncHistoryPageToSelected() {
  if (!historyEntries.length) {
    historyPage = 1;
    return;
  }

  const selectedIndex = selectedHistoryEntry
    ? historyEntries.findIndex((entry) => entry.id === selectedHistoryEntry.id)
    : -1;
  historyPage = selectedIndex >= 0
    ? Math.floor(selectedIndex / HISTORY_PAGE_SIZE) + 1
    : clampHistoryPage(historyPage);
}

function getCurrentHistoryPageEntries() {
  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  return historyEntries.slice(start, start + HISTORY_PAGE_SIZE);
}

function getHistoryPageCount() {
  return Math.max(1, Math.ceil(historyEntries.length / HISTORY_PAGE_SIZE));
}

function clampHistoryPage(page) {
  const numericPage = Number(page);
  if (!Number.isFinite(numericPage)) return 1;
  return Math.min(Math.max(1, Math.trunc(numericPage)), getHistoryPageCount());
}

function renderHistoryButton() {
  historyButton.textContent = `历史页 ${historyEntries.length}`;
}

async function syncMokaCandidatePage(entry) {
  if (!entry?.mokaDetailUrl) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "RESUME_COPILOT_OPEN_MOKA_CANDIDATE",
      payload: {
        url: entry.mokaDetailUrl
      }
    });
    if (!response?.ok) throw new Error(response?.error || "Moka page sync failed");
  } catch (error) {
    setStatus(error.message || String(error), "error");
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = 0;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
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
  const mokaHeaderMetadata = await extractMokaHeaderMetadataFromTab(tab);
  return {
    ...extraction,
    source: getSourceLabelForUrl(tab.url),
    pageKey: getResumePageKey(tab.url),
    pageUrl: tab.url || "",
    mokaApplicationId: getMokaApplicationId(tab.url),
    mokaDetailUrl: getMokaDetailUrl(tab.url),
    mokaPositionRaw: extraction.mokaPositionRaw || mokaHeaderMetadata.positionRaw || "",
    mokaPositionTitle: extraction.mokaPositionTitle || mokaHeaderMetadata.positionTitle || "",
    candidateName: mokaHeaderMetadata.candidateName || extraction.candidateName || ""
  };
}

async function extractMokaHeaderMetadataFromTab(tab) {
  if (!tab?.id || !getMokaDetailUrl(tab.url) || !chrome.scripting?.executeScript) {
    return { candidateName: "", positionRaw: "", positionTitle: "" };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selector = ".candidate-header-info__item-pandect-current,[class*='candidate-header-info__item-pandect-current']";
        const nodes = [];
        for (const headerRoot of document.querySelectorAll(".candidate-header-info")) {
          if (isVisible(headerRoot)) nodes.push(...headerRoot.querySelectorAll(selector));
        }
        nodes.push(...document.querySelectorAll(selector));

        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const raw = normalizeLine(node.textContent || "");
          const title = normalizeMokaPositionTitle(raw);
          if (title) {
            return {
              candidateName: extractCandidateName(),
              positionRaw: raw,
              positionTitle: title
            };
          }
        }
        return { candidateName: extractCandidateName(), positionRaw: "", positionTitle: "" };

        function extractCandidateName() {
          for (const headerRoot of document.querySelectorAll(".candidate-header-info")) {
            if (!isVisible(headerRoot)) continue;
            const nameNode = headerRoot.querySelector(".candidate-header-info__name,[class*='candidate-header-info__name']");
            const name = normalizeCandidateName(nameNode?.textContent || "");
            if (name) return name;
          }
          return "";
        }

        function normalizeCandidateName(value) {
          const text = normalizeLine(value)
            .replace(/[^\u4e00-\u9fa5A-Za-z.'\-\s]/g, "")
            .trim();
          if (/^[\u4e00-\u9fa5]{2,6}$/.test(text)) return text;
          if (/^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/.test(text)) return text;
          return "";
        }

        function normalizeMokaPositionTitle(value) {
          const raw = normalizeLine(value);
          if (!raw) return "";
          const title = raw
            .split(/\s*[\u00b7\u2022|｜]\s*/)[0]
            .replace(/[（(]\s*人才推荐\s*[）)]/g, "")
            .trim();
          if (!title || /已申请|人才推荐/.test(title)) return "";
          return title.length <= 60 ? title : "";
        }

        function normalizeLine(value) {
          return String(value || "")
            .replace(/\u00a0/g, " ")
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }

        function isVisible(node) {
          if (!(node instanceof Element)) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 1 &&
            rect.height > 1 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || 1) > 0
          );
        }
      }
    });
    return result?.result || { positionRaw: "", positionTitle: "" };
  } catch {
    return { candidateName: "", positionRaw: "", positionTitle: "" };
  }
}

function buildResumeFromExtraction(extraction) {
  const imageUrls = extraction.imageUrls || [];
  const text = String(extraction.text || "");
  return {
    source: extraction.source || "网页简历",
    pageKey: extraction.pageKey || "",
    pageUrl: extraction.pageUrl || "",
    mokaApplicationId: extraction.mokaApplicationId || "",
    mokaDetailUrl: extraction.mokaDetailUrl || "",
    mokaPositionRaw: extraction.mokaPositionRaw || "",
    mokaPositionTitle: extraction.mokaPositionTitle || "",
    candidateName: extraction.candidateName,
    text,
    imageUrls,
    debug: extraction.debug || {},
    summary: `${extraction.candidateName || "姓名未识别"} · 已采集 ${text.length} 个字符${imageUrls.length ? ` · ${imageUrls.length} 张简历图` : ""}`
  };
}

function getSourceLabelForUrl(url) {
  if (/mokahr/i.test(String(url || ""))) return "Moka 页面";
  if (/zhipin/i.test(String(url || ""))) return "BOSS 页面";
  return "网页简历";
}

function renderSelectedHistoryReport({ force = false } = {}) {
  const reportSignature = selectedHistoryEntry ? createReportSignature(selectedHistoryEntry) : "empty";
  if (!force && reportSignature === lastRenderedReportSignature) return;

  lastRenderedReportSignature = reportSignature;
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
    reportRoot.append(renderOfferApplicationSection(selectedHistoryEntry));
    reportRoot.append(renderResumeExtractionDebugSection(selectedHistoryEntry));
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

function renderResumeExtractionDebugSection(entry) {
  const section = document.createElement("section");
  section.className = "report-section resume-debug";

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "简历采集调试";
  details.append(summary);

  const extractedText = String(entry.analysis?.resumeExtractedText || "");
  const pageTextLength = Number(entry.resumeTextLength || 0);
  const extractedTextLength = Number(entry.resumeExtractedTextLength || extractedText.length || 0);
  const imageCount = Number(entry.resumeImageCount || extractResumeImageCountFromSummary(entry.resumeSummary));
  const captureDebug = entry.resumeCaptureDebug || {};
  const keywordHits = findResumeKeywordHits(extractedText || entry.resumePreview || "");

  const stats = document.createElement("dl");
  stats.className = "resume-debug-stats";
  for (const [label, value] of [
    ["页面文本", pageTextLength ? `${pageTextLength} 字符` : "未记录"],
    ["OCR合并文本", extractedTextLength ? `${extractedTextLength} 字符` : "未记录"],
    ["简历图片", imageCount ? `${imageCount} 张` : "未记录"],
    ["PDF容器", Number(captureDebug.pdfResumeRoots) ? `${captureDebug.pdfResumeRoots} 个` : "未记录"],
    ["PDF图片标签", Number(captureDebug.pdfResumeImgTags) ? `${captureDebug.pdfResumeImgTags} 个` : "未记录"],
    ["PDF图片样本", Array.isArray(captureDebug.pdfResumeSampleUrls) && captureDebug.pdfResumeSampleUrls.length ? captureDebug.pdfResumeSampleUrls.join("\n") : "未记录"],
    ["关键词", keywordHits.length ? keywordHits.join("、") : "未命中项目/实习关键词"]
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    stats.append(dt, dd);
  }

  const previewLabel = document.createElement("label");
  previewLabel.className = "offer-field offer-field-full";
  const previewTitle = document.createElement("span");
  previewTitle.textContent = "模型收到的简历文本预览";
  const preview = document.createElement("textarea");
  preview.className = "resume-debug-preview";
  preview.readOnly = true;
  preview.rows = 12;
  preview.value = (extractedText || entry.resumePreview || "暂无简历文本预览").slice(0, 6000);
  previewLabel.append(previewTitle, preview);

  details.append(stats, previewLabel);
  section.append(details);
  return section;
}

function extractResumeImageCountFromSummary(summary) {
  const match = String(summary || "").match(/(\d+)\s*张简历图/);
  return match ? Number(match[1]) : 0;
}

function findResumeKeywordHits(text) {
  const haystack = String(text || "");
  return ["项目经历", "项目经验", "实习经历", "工作经历", "专业技能", "技能", "项目描述", "主要技术", "主要职责"]
    .filter((keyword) => haystack.includes(keyword));
}

function renderOfferApplicationSection(entry) {
  let currentOffer = getOfferApplication(entry);
  const section = document.createElement("section");
  section.className = "report-section offer-application";

  const heading = document.createElement("h2");
  heading.textContent = "Offer申请模板";

  const headhunterLabel = document.createElement("label");
  headhunterLabel.className = "offer-field offer-field-full";
  const headhunterTitle = document.createElement("span");
  headhunterTitle.textContent = "猎头推荐报告";
  const headhunterReport = document.createElement("textarea");
  headhunterReport.rows = 6;
  headhunterReport.placeholder = "粘贴猎头提供的推荐报告或补充备注";
  headhunterReport.value = currentOffer.headhunterReport;
  headhunterLabel.append(headhunterTitle, headhunterReport);

  const contentLabel = document.createElement("label");
  contentLabel.className = "offer-field offer-field-full";
  const contentTitle = document.createElement("span");
  contentTitle.textContent = "Offer申请内容";
  const content = document.createElement("textarea");
  content.className = "offer-content";
  content.rows = 12;
  content.value = currentOffer.content || composeOfferApplicationContent(currentOffer, entry);
  contentLabel.append(contentTitle, content);

  const status = document.createElement("p");
  status.className = "offer-status";

  const actions = document.createElement("div");
  actions.className = "offer-actions";
  const generateButton = document.createElement("button");
  generateButton.type = "button";
  generateButton.textContent = "生成模板";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "button-secondary";
  saveButton.textContent = "保存";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "button-secondary";
  copyButton.textContent = "复制Offer申请";

  actions.append(generateButton, saveButton, copyButton);
  section.append(heading, headhunterLabel, contentLabel, actions, status);

  const controls = {
    headhunterReport,
    content
  };

  generateButton.addEventListener("click", async () => {
    const nextOffer = collectOfferApplication(controls, currentOffer);
    try {
      setOfferBusy([generateButton, saveButton, copyButton], true);
      status.textContent = "正在生成模板…";
      const response = await chrome.runtime.sendMessage({
        type: "RESUME_COPILOT_GENERATE_OFFER_APPLICATION",
        payload: {
          candidateName: entry.candidateName,
          profile: entry.profile,
          analysis: entry.analysis,
          resumeText: entry.analysis?.resumeExtractedText || entry.resumePreview || "",
          headhunterReport: nextOffer.headhunterReport,
          mokaPositionTitle: entry.mokaPositionTitle || ""
        }
      });
      if (!response?.ok) throw new Error(response?.error || "Offer申请模板生成失败");

      nextOffer.generatedFields = {
        ...getDefaultOfferApplication().generatedFields,
        ...(response.fields || {})
      };
      nextOffer.generatedFields.positioning = entry.mokaPositionTitle || nextOffer.generatedFields.positioning || "";
      nextOffer.content = composeOfferApplicationContent(nextOffer, entry);
      content.value = nextOffer.content;
      await persistOfferApplication(entry, nextOffer);
      currentOffer = nextOffer;
      status.textContent = "模板已生成并保存";
      setStatus("Offer申请模板已生成", "success");
    } catch (error) {
      status.textContent = error.message || String(error);
      setStatus(error.message || String(error), "error");
    } finally {
      setOfferBusy([generateButton, saveButton, copyButton], false);
    }
  });

  saveButton.addEventListener("click", async () => {
    try {
      const nextOffer = collectOfferApplication(controls, currentOffer);
      await persistOfferApplication(entry, nextOffer);
      currentOffer = nextOffer;
      status.textContent = "已保存";
      setStatus("Offer申请模板已保存", "success");
    } catch (error) {
      status.textContent = error.message || String(error);
      setStatus(error.message || String(error), "error");
    }
  });

  copyButton.addEventListener("click", async () => {
    const nextOffer = collectOfferApplication(controls, currentOffer);
    if (!nextOffer.content) {
      nextOffer.content = composeOfferApplicationContent(nextOffer, entry);
      content.value = nextOffer.content;
    }
    await navigator.clipboard.writeText(nextOffer.content);
    status.textContent = "Offer申请内容已复制";
    setStatus("Offer申请内容已复制", "success");
  });

  return section;
}

function collectOfferApplication(controls, previousOffer) {
  return {
    ...getDefaultOfferApplication(),
    generatedFields: {
      ...getDefaultOfferApplication().generatedFields,
      ...(previousOffer.generatedFields || {})
    },
    headhunterReport: controls.headhunterReport.value.trim(),
    content: controls.content.value.trim()
  };
}

async function persistOfferApplication(entry, offerApplication) {
  const nextHistory = await updateAnalysisHistoryEntry(entry.id, { offerApplication });
  historyEntries = nextHistory;
  selectedHistoryEntry = historyEntries.find((item) => item.id === entry.id) || selectedHistoryEntry;
  syncSelectedHistoryEntry();
  lastHistorySignature = createHistorySignature(historyEntries);
  renderHistoryList();
}

function composeOfferApplicationContent(offer, entry) {
  const generated = offer.generatedFields || {};
  const positioning = entry.mokaPositionTitle || generated.positioning || entry.profile?.title || "";
  const basicInfo = [
    ...formatOfferGenderAge(generated.genderAge),
    generated.education || "",
    generated.recentCompanyBackground || ""
  ].map(compactOfferField).filter(Boolean).join("；");
  return [
    "【基础情况】：",
    basicInfo,
    "【定位】：",
    positioning,
    "【亮点】：",
    generated.highlights || ""
  ].join("\n");
}

function formatOfferGenderAge(value) {
  const text = compactOfferField(value).replace(/^性别年龄[:：]\s*/, "");
  if (!text) return [];

  const joinedMatch = text.match(/^([男女])(?:性)?\s*(\d{1,2}\s*岁)$/);
  if (joinedMatch) return [joinedMatch[1], joinedMatch[2]];

  const separatedMatch = text.match(/^([男女])(?:性)?[\s,，;；、/|]+(\d{1,2}\s*岁)$/);
  if (separatedMatch) return [separatedMatch[1], separatedMatch[2]];

  const parts = text.split(/[;；]/).map(compactOfferField).filter(Boolean);
  return parts.length > 1 ? parts : [text];
}

function compactOfferField(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOfferApplication(entry) {
  const defaults = getDefaultOfferApplication();
  const source = entry.offerApplication || {};
  return {
    headhunterReport: source.headhunterReport || "",
    manualFields: {
      ...defaults.manualFields,
      ...(source.manualFields || {})
    },
    generatedFields: {
      ...defaults.generatedFields,
      ...(source.generatedFields || {})
    },
    content: source.content || ""
  };
}

function getDefaultOfferApplication() {
  return {
    headhunterReport: "",
    manualFields: {
      departureReason: "",
      otherOpportunities: "",
      location: "",
      currentSalary: "",
      salaryPlan: "",
      interviewEvaluation: ""
    },
    generatedFields: {
      genderAge: "",
      education: "",
      recentCompanyBackground: "",
      positioning: "",
      highlights: ""
    },
    content: ""
  };
}

function setOfferBusy(buttons, busy) {
  for (const button of buttons) {
    button.disabled = busy;
  }
}

function createTaskSignature(tasks) {
  return JSON.stringify(
    tasks.map((task) => ({
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
      candidateName: task.candidateName,
      matchScore: task.matchScore,
      recommendation: task.recommendation,
      error: task.error,
      errorType: task.errorType,
      progress: task.progress
    }))
  );
}

function createHistorySignature(entries) {
  return JSON.stringify(
    entries.map((entry) => ({
      id: entry.id,
      taskId: entry.taskId,
      candidateName: entry.candidateName,
      createdAt: entry.createdAt,
      source: entry.source,
      mokaApplicationId: entry.mokaApplicationId,
      mokaDetailUrl: entry.mokaDetailUrl,
      mokaPositionTitle: entry.mokaPositionTitle,
      profile: entry.profile,
      matchScore: entry.matchScore,
      recommendation: entry.recommendation,
      copyableConclusion: entry.copyableConclusion,
      offerApplication: entry.offerApplication
    }))
  );
}

function createReportSignature(entry) {
  return JSON.stringify({
    id: entry.id,
    candidateName: entry.candidateName,
    createdAt: entry.createdAt,
    resumeSummary: entry.resumeSummary,
    resumeTextLength: entry.resumeTextLength,
    resumeImageCount: entry.resumeImageCount,
    resumeCaptureDebug: entry.resumeCaptureDebug,
    resumeExtractedTextLength: entry.resumeExtractedTextLength,
    mokaApplicationId: entry.mokaApplicationId,
    mokaDetailUrl: entry.mokaDetailUrl,
    mokaPositionRaw: entry.mokaPositionRaw,
    mokaPositionTitle: entry.mokaPositionTitle,
    profile: entry.profile,
    matchScore: entry.matchScore,
    recommendation: entry.recommendation,
    copyableConclusion: entry.copyableConclusion,
    offerApplication: entry.offerApplication,
    analysis: entry.analysis,
    batchResults: entry.batchResults
  });
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
    entry.mokaPositionTitle,
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
