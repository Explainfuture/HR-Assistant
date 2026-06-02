import { compactText, createId, ensureArray, normalizeJobProfile } from "./jsonUtils.js";
import { isCandidateNameRecognized, isResumeTagLikeCandidateName } from "./candidateUtils.js";

const SETTINGS_KEY = "resumeCopilot.settings";
const JOB_PROFILES_KEY = "resumeCopilot.jobProfiles";
const ANALYSIS_HISTORY_KEY = "resumeCopilot.analysisHistory";
const ANALYSIS_TASKS_KEY = "resumeCopilot.analysisTasks";
const BACKUP_SCHEMA_VERSION = 1;
const MAX_ANALYSIS_HISTORY = 50;
const MAX_ANALYSIS_TASKS = 40;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "doubao-seed-2-0-mini-260428"
};

export async function getSettings() {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...(result[SETTINGS_KEY] || {})
  };
}

export async function saveSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...settings,
    apiKey: String(settings.apiKey || "").trim(),
    model: String(settings.model || DEFAULT_SETTINGS.model).trim()
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function listJobProfiles() {
  const result = await chrome.storage.local.get(JOB_PROFILES_KEY);
  return Array.isArray(result[JOB_PROFILES_KEY])
    ? result[JOB_PROFILES_KEY].map((profile) => normalizeJobProfile(profile))
    : [];
}

export async function saveJobProfile(profile) {
  const profiles = await listJobProfiles();
  const index = profiles.findIndex((item) => item.id === profile.id);
  const nextProfiles =
    index === -1
      ? [...profiles, profile]
      : profiles.map((item) => (item.id === profile.id ? profile : item));

  await chrome.storage.local.set({ [JOB_PROFILES_KEY]: nextProfiles });
  return nextProfiles;
}

export async function deleteJobProfile(id) {
  const profiles = await listJobProfiles();
  const nextProfiles = profiles.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [JOB_PROFILES_KEY]: nextProfiles });
  return nextProfiles;
}

export async function listAnalysisHistory() {
  const result = await chrome.storage.local.get(ANALYSIS_HISTORY_KEY);
  return Array.isArray(result[ANALYSIS_HISTORY_KEY])
    ? dedupeAnalysisHistory(result[ANALYSIS_HISTORY_KEY].map(normalizeAnalysisHistoryEntry).filter(Boolean))
    : [];
}

export async function saveAnalysisHistoryEntry(entry) {
  const history = await listAnalysisHistory();
  const nextEntry = normalizeAnalysisHistoryEntry(entry);
  const nextHistory = [
    nextEntry,
    ...history.filter((item) => !isSameAnalysisHistoryEntry(item, nextEntry))
  ]
    .filter(Boolean)
    .slice(0, MAX_ANALYSIS_HISTORY);

  await chrome.storage.local.set({ [ANALYSIS_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

export async function clearAnalysisHistory() {
  await chrome.storage.local.remove(ANALYSIS_HISTORY_KEY);
  return [];
}

export async function deleteAnalysisHistoryEntry(id) {
  const targetId = compactText(id);
  if (!targetId) return listAnalysisHistory();

  const history = await listAnalysisHistory();
  const nextHistory = history.filter((entry) => entry.id !== targetId);
  await chrome.storage.local.set({ [ANALYSIS_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

function isSameAnalysisHistoryEntry(entry, nextEntry) {
  if (!entry || !nextEntry) return false;
  if (nextEntry.resumeFingerprint && entry.resumeFingerprint === nextEntry.resumeFingerprint) return true;
  if (nextEntry.taskId && entry.taskId === nextEntry.taskId) return true;
  if (nextEntry.id && entry.id === nextEntry.id) return true;
  return false;
}

function dedupeAnalysisHistory(history) {
  const seen = new Set();
  const deduped = [];

  for (const entry of history) {
    const key = entry.resumeFingerprint || entry.taskId || entry.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

export async function deleteAnalysisHistoryEntries(ids) {
  const targetIds = new Set(ensureArray(ids).map(compactText).filter(Boolean));
  if (!targetIds.size) return listAnalysisHistory();

  const history = await listAnalysisHistory();
  const nextHistory = history.filter((entry) => !targetIds.has(entry.id) && !targetIds.has(entry.taskId));
  await chrome.storage.local.set({ [ANALYSIS_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

export async function updateAnalysisHistoryEntry(id, patch) {
  const history = await listAnalysisHistory();
  const nextHistory = history.map((entry) =>
    entry.id === id ? normalizeAnalysisHistoryEntry({ ...entry, ...patch }) : entry
  );
  await chrome.storage.local.set({ [ANALYSIS_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

export async function listAnalysisTasks() {
  const result = await chrome.storage.local.get(ANALYSIS_TASKS_KEY);
  return Array.isArray(result[ANALYSIS_TASKS_KEY])
    ? result[ANALYSIS_TASKS_KEY].map(normalizeAnalysisTask).filter(Boolean)
    : [];
}

export async function saveAnalysisTasks(tasks) {
  const nextTasks = ensureArray(tasks)
    .map(normalizeAnalysisTask)
    .filter(Boolean)
    .slice(0, MAX_ANALYSIS_TASKS);
  await chrome.storage.local.set({ [ANALYSIS_TASKS_KEY]: nextTasks });
  return nextTasks;
}

export async function exportResumeCopilotData() {
  const [settings, jobProfiles, analysisHistory, analysisTasks] = await Promise.all([
    getSettings(),
    listJobProfiles(),
    listAnalysisHistory(),
    listAnalysisTasks()
  ]);

  return {
    app: "Resume Copilot",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: {
      settings,
      jobProfiles,
      analysisHistory,
      analysisTasks
    }
  };
}

export async function importResumeCopilotData(backup) {
  const data = normalizeBackupData(backup);

  const sourceSettings = data.settings && typeof data.settings === "object" ? data.settings : {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...sourceSettings
  };
  const jobProfiles = ensureArray(data.jobProfiles)
    .filter((profile) => profile && typeof profile === "object" && (profile.id || profile.title || profile.jd))
    .map((profile) => normalizeJobProfile(profile))
    .filter(Boolean);
  const analysisHistory = ensureArray(data.analysisHistory)
    .map(normalizeAnalysisHistoryEntry)
    .filter(Boolean)
    .slice(0, MAX_ANALYSIS_HISTORY);
  const analysisTasks = ensureArray(data.analysisTasks)
    .map(normalizeAnalysisTask)
    .filter(Boolean)
    .slice(0, MAX_ANALYSIS_TASKS);

  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...DEFAULT_SETTINGS,
      apiKey: String(settings.apiKey || "").trim(),
      model: String(settings.model || DEFAULT_SETTINGS.model).trim()
    },
    [JOB_PROFILES_KEY]: jobProfiles,
    [ANALYSIS_HISTORY_KEY]: analysisHistory,
    [ANALYSIS_TASKS_KEY]: analysisTasks
  });

  return {
    settings,
    jobProfiles,
    analysisHistory,
    analysisTasks
  };
}

function normalizeBackupData(backup) {
  if (!backup || typeof backup !== "object") {
    throw new Error("备份文件格式不正确");
  }

  const data = backup.data && typeof backup.data === "object" ? backup.data : backup;
  if (!data.settings && !data.jobProfiles && !data.analysisHistory && !data.analysisTasks) {
    throw new Error("没有找到可导入的 Resume Copilot 配置");
  }

  return data;
}

function normalizeAnalysisHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const profile = entry.profile || {};
  const candidateName = compactText(entry.candidateName || entry.analysis?.candidateName || "");
  if (isResumeTagLikeCandidateName(candidateName)) return null;
  return {
    id: compactText(entry.id || entry.taskId) || createId(),
    taskId: compactText(entry.taskId || ""),
    resumeFingerprint: compactText(entry.resumeFingerprint || ""),
    createdAt: compactText(entry.createdAt) || new Date().toISOString(),
    source: compactText(entry.source || "未知来源"),
    pageKey: compactText(entry.pageKey || ""),
    pageUrl: compactText(entry.pageUrl || ""),
    mokaApplicationId: compactText(entry.mokaApplicationId || ""),
    mokaDetailUrl: compactText(entry.mokaDetailUrl || ""),
    mokaPositionRaw: compactText(entry.mokaPositionRaw || ""),
    mokaPositionTitle: compactText(entry.mokaPositionTitle || ""),
    candidateName: isCandidateNameRecognized(candidateName) ? candidateName : "姓名未识别",
    resumeSummary: compactText(entry.resumeSummary || ""),
    resumePreview: compactText(entry.resumePreview || "").slice(0, 180),
    resumeTextLength: normalizeNonNegativeInteger(entry.resumeTextLength),
    resumeImageCount: normalizeNonNegativeInteger(entry.resumeImageCount),
    resumeCaptureDebug: normalizeResumeCaptureDebug(entry.resumeCaptureDebug),
    resumeExtractedTextLength: normalizeNonNegativeInteger(entry.resumeExtractedTextLength),
    profile: {
      id: compactText(profile.id || entry.profileId || ""),
      title: compactText(profile.title || entry.profileTitle || "未命名岗位"),
      category: compactText(profile.category || entry.profileCategory || "未分类")
    },
    matchScore: Number(entry.matchScore ?? 0),
    recommendation: compactText(entry.recommendation || "需要人工复核"),
    copyableConclusion: compactText(entry.copyableConclusion || "").slice(0, 320),
    offerApplication: normalizeOfferApplication(entry.offerApplication),
    analysis: entry.analysis && typeof entry.analysis === "object" ? entry.analysis : null,
    batchResults: Array.isArray(entry.batchResults) ? entry.batchResults.slice(0, 50) : []
  };
}

function normalizeOfferApplication(value) {
  const source = value && typeof value === "object" ? value : {};
  const manual = source.manualFields && typeof source.manualFields === "object" ? source.manualFields : {};
  const generated = source.generatedFields && typeof source.generatedFields === "object" ? source.generatedFields : {};
  return {
    headhunterReport: normalizeMultilineText(source.headhunterReport || ""),
    manualFields: {
      departureReason: compactText(manual.departureReason || ""),
      otherOpportunities: compactText(manual.otherOpportunities || ""),
      location: compactText(manual.location || ""),
      currentSalary: compactText(manual.currentSalary || ""),
      salaryPlan: compactText(manual.salaryPlan || ""),
      interviewEvaluation: compactText(manual.interviewEvaluation || "")
    },
    generatedFields: {
      genderAge: compactText(generated.genderAge || ""),
      education: compactText(generated.education || ""),
      recentCompanyBackground: compactText(generated.recentCompanyBackground || ""),
      positioning: compactText(generated.positioning || ""),
      highlights: compactText(generated.highlights || "")
    },
    content: normalizeMultilineText(source.content || "")
  };
}

function normalizeResumeCaptureDebug(value) {
  if (!value || typeof value !== "object") return null;
  return {
    container: compactText(value.container || "").slice(0, 160),
    expandedClicks: normalizeNonNegativeInteger(value.expandedClicks),
    scrollRounds: normalizeNonNegativeInteger(value.scrollRounds),
    rawLength: normalizeNonNegativeInteger(value.rawLength),
    pdfResumeImages: normalizeNonNegativeInteger(value.pdfResumeImages),
    pdfResumeRoots: normalizeNonNegativeInteger(value.pdfResumeRoots),
    pdfResumeImgTags: normalizeNonNegativeInteger(value.pdfResumeImgTags),
    pdfResumeSampleUrls: Array.isArray(value.pdfResumeSampleUrls)
      ? value.pdfResumeSampleUrls.map((url) => compactText(url || "").slice(0, 240)).filter(Boolean).slice(0, 5)
      : [],
    mokaIdentity: value.mokaIdentity && typeof value.mokaIdentity === "object"
      ? {
          name: compactText(value.mokaIdentity.name || "").slice(0, 40),
          text: compactText(value.mokaIdentity.text || "").slice(0, 300),
          positionRaw: compactText(value.mokaIdentity.positionRaw || "").slice(0, 120),
          positionTitle: compactText(value.mokaIdentity.positionTitle || "").slice(0, 40)
        }
      : null
  };
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function normalizeMultilineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeAnalysisTask(task) {
  if (!task || typeof task !== "object") return null;
  const candidateName = compactText(task.candidateName || "姓名未识别");
  if (isResumeTagLikeCandidateName(candidateName)) return null;
  return {
    id: compactText(task.id) || createId(),
    resumeFingerprint: compactText(task.resumeFingerprint || ""),
    mode: task.mode === "auto" ? "auto" : "single",
    status: ["queued", "running", "done", "error"].includes(task.status) ? task.status : "queued",
    createdAt: compactText(task.createdAt) || new Date().toISOString(),
    updatedAt: compactText(task.updatedAt) || new Date().toISOString(),
    candidateName,
    source: compactText(task.source || "未知来源"),
    profileId: compactText(task.profileId || ""),
    profileTitle: compactText(task.profileTitle || ""),
    profileCategory: compactText(task.profileCategory || ""),
    matchScore: task.matchScore == null ? null : Number(task.matchScore),
    recommendation: compactText(task.recommendation || ""),
    progress: task.progress && typeof task.progress === "object"
      ? {
          finished: Number(task.progress.finished || 0),
          total: Number(task.progress.total || 0),
          stage: compactText(task.progress.stage || ""),
          ocrFinished: Number(task.progress.ocrFinished || 0),
          ocrTotal: Number(task.progress.ocrTotal || 0)
        }
      : { finished: 0, total: 0, stage: "", ocrFinished: 0, ocrTotal: 0 },
    error: compactText(task.error || ""),
    errorType: compactText(task.errorType || "")
  };
}
