import { analyzeCandidate, analyzeCandidateAgainstProfiles } from "./shared/deepseekClient.js";
import { inferCandidateName, isCandidateNameRecognized } from "./shared/candidateUtils.js";
import {
  getSettings,
  listJobProfiles,
  listAnalysisHistory,
  listAnalysisTasks,
  saveAnalysisTasks,
  saveAnalysisHistoryEntry
} from "./shared/storage.js";
import { createId } from "./shared/jsonUtils.js";
import { ERROR_TYPES, normalizeTaskError } from "./shared/errorUtils.js";
import { createResumeFingerprint } from "./shared/resumeFingerprint.js";

const TASK_CONCURRENCY = 2;
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

  return false;
});

async function submitTask(payload) {
  const resumeText = String(payload?.resume?.text || "").trim();
  const resumeImageUrls = Array.isArray(payload?.resume?.imageUrls)
    ? payload.resume.imageUrls.filter(Boolean).slice(0, 8)
    : [];
  if (resumeText.length < 80 && !resumeImageUrls.length) {
    throw new Error("简历文本过短，无法提交后台分析");
  }

  const candidateName = inferCandidateName(
    resumeText,
    payload?.resume?.candidateName || payload?.resume?.fallbackName
  );
  const resumeFingerprint = createResumeFingerprint({
    text: resumeText,
    imageUrls: resumeImageUrls
  });

  if (payload?.dedupe !== false && resumeFingerprint) {
    const duplicate = await findDuplicateAnalysis(resumeFingerprint);
    if (duplicate) return duplicate;
  }

  const task = {
    id: createId(),
    resumeFingerprint,
    mode: payload.mode === "auto" ? "auto" : "single",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    candidateName,
    source: payload?.resume?.source || "未知来源",
    resume: {
      text: resumeText,
      imageUrls: resumeImageUrls,
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

  task.progress = { finished: 0, total: 1 };
  const analysis = await analyzeCandidate({
    apiKey: settings.apiKey,
    model: settings.model,
    jobProfile: profile,
    resumeText: task.resume.text,
    resumeImages: task.resume.imageUrls || []
  });
  task.progress = { finished: 1, total: 1 };
  await completeTask(task, profile, analysis, []);
}

async function runAutoTask(task, settings, profiles) {
  const candidates = task.category
    ? profiles.filter((profile) => profile.category === task.category)
    : profiles;
  if (!candidates.length) throw new Error("当前大类下没有可用于自动匹配的岗位知识库");

  task.progress = { finished: 0, total: candidates.length };
  const results = await analyzeCandidateAgainstProfiles({
    apiKey: settings.apiKey,
    model: settings.model,
    jobProfiles: candidates,
    resumeText: task.resume.text,
    resumeImages: task.resume.imageUrls || [],
    concurrency: 3,
    onProgress: ({ finished, total }) => {
      task.progress = { finished, total };
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
  await completeTask(task, best.profile, best.analysis, summarizeBatchResults(results));
}

async function completeTask(task, profile, analysis, batchResults) {
  const candidateName = isCandidateNameRecognized(analysis?.candidateName)
    ? analysis.candidateName
    : task.candidateName;
  task.candidateName = candidateName;

  task.result = {
    profile,
    analysis,
    batchResults
  };

  await saveAnalysisHistoryEntry({
    taskId: task.id,
    resumeFingerprint: task.resumeFingerprint,
    source: task.source,
    candidateName,
    resumeSummary: task.resume.summary,
    resumePreview: task.resume.preview,
    profile: {
      id: profile.id,
      title: profile.title,
      category: profile.category
    },
    matchScore: analysis?.matchedRole?.matchScore,
    recommendation: analysis?.matchedRole?.recommendation,
    copyableConclusion: analysis?.copyableConclusion,
    analysis,
    batchResults
  });
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
