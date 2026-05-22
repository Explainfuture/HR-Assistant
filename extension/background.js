import { analyzeCandidate, analyzeCandidateAgainstProfiles } from "./shared/deepseekClient.js";
import { inferCandidateName, isCandidateNameRecognized } from "./shared/candidateUtils.js";
import {
  getSettings,
  listJobProfiles,
  saveAnalysisHistoryEntry
} from "./shared/storage.js";
import { createId } from "./shared/jsonUtils.js";

const TASK_CONCURRENCY = 2;
const MAX_TASKS = 40;
const tasks = [];
let runningCount = 0;

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // Older Chrome builds may not support this setting.
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "RESUME_COPILOT_SUBMIT_ANALYSIS_TASK") {
    submitTask(message.payload)
      .then((task) => sendResponse({ ok: true, task }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "RESUME_COPILOT_LIST_ANALYSIS_TASKS") {
    sendResponse({ ok: true, tasks: serializeTasks() });
    return false;
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
  const task = {
    id: createId(),
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
    task.status = "error";
    task.error = error.message || String(error);
    task.updatedAt = new Date().toISOString();
  }
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
    error: task.error
  };
}

function getMatchScore(analysis) {
  return Number(analysis?.matchedRole?.matchScore ?? 0);
}
