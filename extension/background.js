import {
  analyzeCandidate,
  analyzeCandidateAgainstProfiles,
  generateOfferApplicationFields
} from "./shared/deepseekClient.js";
import {
  inferCandidateName,
  isCandidateNameRecognized,
  isResumeTagLikeCandidateName
} from "./shared/candidateUtils.js";
import {
  getSettings,
  listJobProfiles,
  listAnalysisHistory,
  listAnalysisTasks,
  saveAnalysisTasks,
  saveAnalysisHistoryEntry,
  updateAnalysisHistoryEntry
} from "./shared/storage.js";
import { createId } from "./shared/jsonUtils.js";
import { ERROR_TYPES, normalizeTaskError } from "./shared/errorUtils.js";
import { createResumeFingerprint } from "./shared/resumeFingerprint.js";
import { getMokaApplicationId, getMokaDetailUrl } from "./shared/pagePolicy.js";

const TASK_CONCURRENCY = 10;
const MAX_TASKS = 40;
const tasks = [];
let runningCount = 0;
const tasksReady = hydratePersistedTasks();

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Older Chrome builds may not support this setting.
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RESUME_COPILOT_SUBMIT_ANALYSIS_TASK") {
    ensureTasksReady().then(() => submitTask(message.payload))
      .then((task) => sendResponse({ ok: true, task }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "RESUME_COPILOT_LIST_ANALYSIS_TASKS") {
    ensureTasksReady()
      .then(() => sendResponse({ ok: true, tasks: serializeTasks() }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "RESUME_COPILOT_GENERATE_OFFER_APPLICATION") {
    ensureTasksReady().then(() => generateOfferApplication(message.payload))
      .then((fields) => sendResponse({ ok: true, fields }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "RESUME_COPILOT_OPEN_MOKA_CANDIDATE") {
    openMokaCandidatePage(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});

const MOKA_TAB_URL_PATTERNS = [
  "https://mokahr.com/*",
  "https://*.mokahr.com/*",
  "https://*.mokahr.com.cn/*"
];

async function openMokaCandidatePage(payload = {}) {
  const targetUrl = getMokaDetailUrl(payload?.url);
  if (!targetUrl) throw new Error("Moka candidate URL is unavailable");

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const mokaTabs = await chrome.tabs.query({ url: MOKA_TAB_URL_PATTERNS });
  const targetTab = selectMokaTabForNavigation(mokaTabs, activeTab);

  if (targetTab?.id) {
    const tab = await chrome.tabs.update(targetTab.id, { url: targetUrl, active: true });
    return { tabId: tab?.id || targetTab.id, url: targetUrl };
  }

  const tab = await chrome.tabs.create({ url: targetUrl });
  return { tabId: tab?.id || 0, url: targetUrl };
}

function selectMokaTabForNavigation(mokaTabs, activeTab) {
  if (!Array.isArray(mokaTabs) || !mokaTabs.length) return null;
  if (activeTab?.id) {
    const activeMokaTab = mokaTabs.find((tab) => tab.id === activeTab.id);
    if (activeMokaTab) return activeMokaTab;
  }

  const activeWindowId = activeTab?.windowId;
  return mokaTabs.find((tab) => tab.windowId === activeWindowId && tab.active) ||
    mokaTabs.find((tab) => tab.windowId === activeWindowId) ||
    mokaTabs[0] ||
    null;
}

async function submitTask(payload) {
  const resumeText = String(payload?.resume?.text || "").trim();
  const resumeImageUrls = Array.isArray(payload?.resume?.imageUrls)
    ? payload.resume.imageUrls.filter(Boolean)
    : [];
  if (resumeText.length < 80 && !resumeImageUrls.length) {
    throw new Error("简历文本过短，无法提交后台分析");
  }

  const rawCandidateName = payload?.resume?.candidateName || payload?.resume?.fallbackName || "";
  const source = payload?.resume?.source || "未知来源";
  const candidateName = /moka/i.test(source) && isCandidateNameRecognized(rawCandidateName)
    ? rawCandidateName
    : inferCandidateName(
        resumeText,
        rawCandidateName
      );
  if (/moka/i.test(source) && !payload?.resume?.pageKey) {
    throw new Error("请打开 Moka 候选人详情页后再解析");
  }
  if (isResumeTagLikeCandidateName(candidateName) || (!isCandidateNameRecognized(candidateName) && isResumeTagLikeCandidateName(rawCandidateName))) {
    throw new Error("当前页面不是候选人详情，请打开具体候选人简历后再解析");
  }
  const resumeFingerprint = createResumeFingerprint({
    pageKey: payload?.resume?.pageKey,
    text: resumeText,
    imageUrls: resumeImageUrls
  });

  if (payload?.dedupe !== false && resumeFingerprint) {
    const duplicate = await findDuplicateAnalysis(resumeFingerprint);
    if (duplicate) {
      await updateDuplicateAnalysisMetadata(duplicate, payload?.resume);
      return duplicate;
    }
  }

  const task = {
    id: createId(),
    resumeFingerprint,
    mode: payload.mode === "auto" ? "auto" : "single",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateName,
    source,
    resume: {
      pageKey: payload?.resume?.pageKey || "",
      pageUrl: payload?.resume?.pageUrl || "",
      mokaApplicationId: payload?.resume?.mokaApplicationId || getMokaApplicationId(payload?.resume?.mokaDetailUrl || payload?.resume?.pageUrl),
      mokaDetailUrl: payload?.resume?.mokaDetailUrl || getMokaDetailUrl(payload?.resume?.pageUrl),
      mokaPositionRaw: payload?.resume?.mokaPositionRaw || "",
      mokaPositionTitle: payload?.resume?.mokaPositionTitle || "",
      text: resumeText,
      imageUrls: resumeImageUrls,
      captureDebug: normalizeCaptureDebug(payload?.resume?.debug),
      summary: payload?.resume?.summary || "",
      preview: resumeText.slice(0, 180)
    },
    profileId: payload?.profileId || "",
    category: payload?.category || "",
    progress: {
      finished: 0,
      total: 0
    },
    result: null,
    error: ""
  };

  tasks.unshift(task);
  if (tasks.length > MAX_TASKS) {
    tasks.splice(MAX_TASKS);
  }
  await persistTasks();
  scheduleQueue();
  return serializeTask(task);
}

async function updateDuplicateAnalysisMetadata(duplicate, resume) {
  if (duplicate?.duplicateSource !== "history") return;
  const id = duplicate.id || duplicate.taskId;
  if (!id || !resume || typeof resume !== "object") return;

  const pageUrl = String(resume.pageUrl || "").trim();
  const mokaDetailUrl = String(resume.mokaDetailUrl || getMokaDetailUrl(pageUrl)).trim();
  const patch = {
    pageKey: String(resume.pageKey || "").trim(),
    pageUrl,
    mokaApplicationId: String(resume.mokaApplicationId || getMokaApplicationId(mokaDetailUrl || pageUrl)).trim(),
    mokaDetailUrl,
    mokaPositionRaw: String(resume.mokaPositionRaw || "").trim(),
    mokaPositionTitle: String(resume.mokaPositionTitle || "").trim()
  };

  const hasPatch = Object.values(patch).some(Boolean);
  if (!hasPatch) return;
  await updateAnalysisHistoryEntry(id, patch);
}

function normalizeCaptureDebug(debug) {
  if (!debug || typeof debug !== "object") return null;
  const mokaIdentity = debug.mokaIdentity && typeof debug.mokaIdentity === "object"
    ? {
        name: String(debug.mokaIdentity.name || "").slice(0, 40),
        text: String(debug.mokaIdentity.text || "").slice(0, 300),
        positionRaw: String(debug.mokaIdentity.positionRaw || "").slice(0, 120),
        positionTitle: String(debug.mokaIdentity.positionTitle || "").slice(0, 40)
      }
    : null;
  return {
    container: String(debug.container || "").slice(0, 160),
    expandedClicks: Number(debug.expandedClicks || 0),
    scrollRounds: Number(debug.scrollRounds || 0),
    rawLength: Number(debug.rawLength || 0),
    pdfResumeImages: Number(debug.pdfResumeImages || 0),
    pdfResumeRoots: Number(debug.pdfResumeRoots || 0),
    pdfResumeImgTags: Number(debug.pdfResumeImgTags || 0),
    pdfResumeSampleUrls: Array.isArray(debug.pdfResumeSampleUrls)
      ? debug.pdfResumeSampleUrls.map((url) => String(url || "").slice(0, 240)).filter(Boolean).slice(0, 5)
      : [],
    mokaIdentity
  };
}

async function generateOfferApplication(payload = {}) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("请先在 Options 页面配置 Doubao API Key");

  const fields = await generateOfferApplicationFields({
    apiKey: settings.apiKey,
    model: settings.model,
    candidateName: payload.candidateName || "",
    profile: payload.profile || {},
    analysis: payload.analysis || {},
    resumeText: payload.resumeText || "",
    headhunterReport: payload.headhunterReport || ""
  });
  return payload.mokaPositionTitle
    ? { ...fields, positioning: payload.mokaPositionTitle }
    : fields;
}

function scheduleQueue() {
  while (runningCount < TASK_CONCURRENCY) {
    const task = tasks.find((item) => item.status === "queued");
    if (!task) return;

    runningCount += 1;
    runTask(task).finally(() => {
      runningCount -= 1;
      scheduleQueue();
    });
  }
}

async function runTask(task) {
  task.status = "running";
  task.updatedAt = new Date().toISOString();
  await persistTasks();

  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error("请先在 Options 页面配置 Doubao API Key");

    const profiles = await listJobProfiles();
    if (!profiles.length) throw new Error("请先在设置中新增岗位知识库");

    if (task.mode === "auto") {
      await runAutoTask(task, settings, profiles);
    } else {
      await runSingleTask(task, settings, profiles);
    }

    task.status = "done";
    task.updatedAt = new Date().toISOString();
  } catch (error) {
    const taskError = normalizeTaskError(error);
    task.status = "error";
    task.error = taskError.message;
    task.errorType = taskError.type;
    task.updatedAt = new Date().toISOString();
  }
  await persistTasks();
}

async function runSingleTask(task, settings, profiles) {
  const profile = profiles.find((item) => item.id === task.profileId);
  if (!profile) throw new Error("请先选择一个岗位知识库");

  task.progress = {
    finished: 0,
    total: 1,
    stage: task.resume.imageUrls?.length ? "ocr" : "matching",
    ocrFinished: 0,
    ocrTotal: task.resume.imageUrls?.length || 0
  };
  await persistTasks();
  const analysis = await analyzeCandidate({
    apiKey: settings.apiKey,
    model: settings.model,
    jobProfile: profile,
    resumeText: task.resume.text,
    resumeImages: task.resume.imageUrls || [],
    onProgress: ({ finished, total, stage, ocrFinished, ocrTotal }) => {
      task.progress = {
        finished,
        total,
        stage: stage || "matching",
        ocrFinished: Number(ocrFinished || 0),
        ocrTotal: Number(ocrTotal || 0)
      };
      task.updatedAt = new Date().toISOString();
      persistTasks().catch(() => {});
    }
  });
  task.progress = { finished: 1, total: 1, stage: "matching" };
  await completeTask(task, profile, analysis, [], settings);
}

async function runAutoTask(task, settings, profiles) {
  const candidates = task.category
    ? profiles.filter((profile) => profile.category === task.category)
    : profiles;
  if (!candidates.length) throw new Error("当前大类下没有可用于自动匹配的岗位知识库");

  task.progress = {
    finished: 0,
    total: candidates.length,
    stage: task.resume.imageUrls?.length ? "ocr" : "matching",
    ocrFinished: 0,
    ocrTotal: task.resume.imageUrls?.length || 0
  };
  await persistTasks();
  const results = await analyzeCandidateAgainstProfiles({
    apiKey: settings.apiKey,
    model: settings.model,
    jobProfiles: candidates,
    resumeText: task.resume.text,
    resumeImages: task.resume.imageUrls || [],
    concurrency: 3,
    onProgress: ({ finished, total, stage, ocrFinished, ocrTotal }) => {
      task.progress = {
        finished,
        total,
        stage: stage || "matching",
        ocrFinished: Number(ocrFinished || 0),
        ocrTotal: Number(ocrTotal || 0)
      };
      task.updatedAt = new Date().toISOString();
      persistTasks().catch(() => {});
    }
  });

  const successful = results.filter((item) => item.analysis);
  if (!successful.length) {
    const firstError = results.find((item) => item.error)?.error || "自动匹配失败";
    throw new Error(firstError);
  }

  const best = successful.reduce((currentBest, item) =>
    getMatchScore(item.analysis) > getMatchScore(currentBest.analysis) ? item : currentBest
  );
  await completeTask(task, best.profile, best.analysis, summarizeBatchResults(results), settings);
}

async function completeTask(task, profile, analysis, batchResults, settings) {
  const candidateName = shouldLockSubmittedCandidateName(task)
    ? task.candidateName
    : (isCandidateNameRecognized(analysis?.candidateName)
      ? analysis.candidateName
      : task.candidateName);
  task.candidateName = candidateName;

  task.result = {
    profile,
    analysis,
    batchResults
  };

  const offerApplication = await buildAutomaticOfferApplication({
    settings,
    candidateName,
    profile,
    analysis,
    resumeText: analysis?.resumeExtractedText || task.resume.text,
    mokaPositionTitle: task.resume.mokaPositionTitle || ""
  });

  await saveAnalysisHistoryEntry({
    taskId: task.id,
    resumeFingerprint: task.resumeFingerprint,
    source: task.source,
    pageKey: task.resume.pageKey || "",
    pageUrl: task.resume.pageUrl || "",
    mokaApplicationId: task.resume.mokaApplicationId || "",
    mokaDetailUrl: task.resume.mokaDetailUrl || "",
    mokaPositionRaw: task.resume.mokaPositionRaw || "",
    mokaPositionTitle: task.resume.mokaPositionTitle || "",
    candidateName,
    resumeSummary: task.resume.summary,
    resumePreview: task.resume.preview,
    resumeTextLength: task.resume.text.length,
    resumeImageCount: task.resume.imageUrls?.length || 0,
    resumeCaptureDebug: task.resume.captureDebug || null,
    resumeExtractedTextLength: String(analysis?.resumeExtractedText || "").length,
    profile: {
      id: profile.id,
      title: profile.title,
      category: profile.category
    },
    matchScore: analysis?.matchedRole?.matchScore,
    recommendation: analysis?.matchedRole?.recommendation,
    copyableConclusion: analysis?.copyableConclusion,
    offerApplication,
    analysis,
    batchResults
  });
}

function shouldLockSubmittedCandidateName(task) {
  return /moka/i.test(task?.source || "") && isCandidateNameRecognized(task?.candidateName);
}

async function buildAutomaticOfferApplication({ settings, candidateName, profile, analysis, resumeText, mokaPositionTitle = "" }) {
  const manualFields = {
    departureReason: "",
    otherOpportunities: "",
    location: "",
    currentSalary: "",
    salaryPlan: "",
    interviewEvaluation: ""
  };
  let generatedFields = {
    genderAge: "",
    education: "",
    recentCompanyBackground: "",
    positioning: mokaPositionTitle || profile?.title || "",
    highlights: analysis?.experienceAnalysis?.oneLineProfile || analysis?.copyableConclusion || ""
  };

  try {
    generatedFields = {
      ...generatedFields,
      ...(await generateOfferApplicationFields({
        apiKey: settings.apiKey,
        model: settings.model,
        candidateName,
        profile,
        analysis,
        resumeText,
        headhunterReport: ""
      }))
    };
  } catch {
    // Keep the main resume analysis successful even if template generation is unavailable.
  }
  generatedFields.positioning = mokaPositionTitle || generatedFields.positioning || profile?.title || "";

  const offerApplication = {
    headhunterReport: "",
    manualFields,
    generatedFields,
    content: ""
  };
  offerApplication.content = composeOfferApplicationContent(offerApplication, profile);
  return offerApplication;
}

function composeOfferApplicationContent(offer, profile) {
  const generated = offer.generatedFields || {};
  const positioning = generated.positioning || profile?.title || "";
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

function summarizeBatchResults(results) {
  return results.map((item) => ({
    profile: {
      id: item.profile?.id || "",
      title: item.profile?.title || "未命名岗位",
      category: item.profile?.category || "未分类"
    },
    matchScore: item.analysis ? getMatchScore(item.analysis) : null,
    recommendation: item.analysis?.matchedRole?.recommendation || "",
    error: item.error || ""
  }));
}

function serializeTasks() {
  return tasks.map(serializeTask);
}

function serializeTask(task) {
  return {
    id: task.id,
    resumeFingerprint: task.resumeFingerprint || "",
    mode: task.mode,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    candidateName: task.candidateName,
    source: task.source,
    profileId: task.result?.profile?.id || task.profileId,
    profileTitle: task.result?.profile?.title || "",
    profileCategory: task.result?.profile?.category || task.category,
    matchScore: task.result?.analysis ? getMatchScore(task.result.analysis) : null,
    recommendation: task.result?.analysis?.matchedRole?.recommendation || "",
    progress: task.progress,
    error: task.error,
    errorType: task.errorType || ""
  };
}

async function findDuplicateAnalysis(resumeFingerprint) {
  const activeTask = tasks.find(
    (task) =>
      task.resumeFingerprint === resumeFingerprint &&
      ["queued", "running"].includes(task.status)
  );
  if (activeTask) {
    return {
      ...serializeTask(activeTask),
      deduped: true,
      duplicateSource: "task"
    };
  }

  const history = await listAnalysisHistory();
  const duplicateHistory = history.find((entry) => entry.resumeFingerprint === resumeFingerprint);
  if (duplicateHistory) {
    return {
      ...serializeHistoryEntryAsTask(duplicateHistory),
      deduped: true,
      duplicateSource: "history"
    };
  }

  const completedTask = tasks.find(
    (task) => task.resumeFingerprint === resumeFingerprint && task.status === "done"
  );
  if (!completedTask) return null;

  return {
    ...serializeTask(completedTask),
    deduped: true,
    duplicateSource: "task"
  };
}

function serializeHistoryEntryAsTask(entry) {
  return {
    id: entry.taskId || entry.id,
    resumeFingerprint: entry.resumeFingerprint || "",
    mode: "auto",
    status: "done",
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
    candidateName: entry.candidateName,
    source: entry.source,
    profileId: entry.profile?.id || "",
    profileTitle: entry.profile?.title || "",
    profileCategory: entry.profile?.category || "",
    matchScore: Number.isFinite(Number(entry.matchScore)) ? Number(entry.matchScore) : null,
    recommendation: entry.recommendation || "",
    progress: {
      finished: 1,
      total: 1
    },
    error: "",
    errorType: ""
  };
}

async function ensureTasksReady() {
  await tasksReady;
}

async function hydratePersistedTasks() {
  const persistedTasks = await listAnalysisTasks();
  const restoredTasks = persistedTasks.map((task) => {
    if (task.status === "queued" || task.status === "running") {
      return {
        ...task,
        status: "error",
        error: "任务被浏览器回收中断，请重新提交分析。",
        errorType: ERROR_TYPES.TASK_INTERRUPTED,
        updatedAt: new Date().toISOString()
      };
    }
    return task;
  });
  tasks.splice(0, tasks.length, ...restoredTasks.slice(0, MAX_TASKS));
  await persistTasks();
}

async function persistTasks() {
  await saveAnalysisTasks(serializeTasks());
}

function getMatchScore(analysis) {
  return Number(analysis?.matchedRole?.matchScore ?? 0);
}
