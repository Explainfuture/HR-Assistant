import { compactText, createId, normalizeJobProfile } from "./jsonUtils.js";
import { isCandidateNameRecognized } from "./candidateUtils.js";

const SETTINGS_KEY = "resumeCopilot.settings";
const JOB_PROFILES_KEY = "resumeCopilot.jobProfiles";
const ANALYSIS_HISTORY_KEY = "resumeCopilot.analysisHistory";
const MAX_ANALYSIS_HISTORY = 50;

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "deepseek-v4-pro"
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
    ? result[ANALYSIS_HISTORY_KEY].map(normalizeAnalysisHistoryEntry).filter(Boolean)
    : [];
}

export async function saveAnalysisHistoryEntry(entry) {
  const history = await listAnalysisHistory();
  const nextEntry = normalizeAnalysisHistoryEntry(entry);
  const nextHistory = [nextEntry, ...history]
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

export async function updateAnalysisHistoryEntry(id, patch) {
  const history = await listAnalysisHistory();
  const nextHistory = history.map((entry) =>
    entry.id === id ? normalizeAnalysisHistoryEntry({ ...entry, ...patch }) : entry
  );
  await chrome.storage.local.set({ [ANALYSIS_HISTORY_KEY]: nextHistory });
  return nextHistory;
}

function normalizeAnalysisHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const profile = entry.profile || {};
  const candidateName = compactText(entry.candidateName || entry.analysis?.candidateName || "");
  return {
    id: compactText(entry.id) || createId(),
    taskId: compactText(entry.taskId || ""),
    createdAt: compactText(entry.createdAt) || new Date().toISOString(),
    source: compactText(entry.source || "未知来源"),
    candidateName: isCandidateNameRecognized(candidateName) ? candidateName : "姓名未识别",
    resumeSummary: compactText(entry.resumeSummary || ""),
    resumePreview: compactText(entry.resumePreview || "").slice(0, 180),
    profile: {
      id: compactText(profile.id || entry.profileId || ""),
      title: compactText(profile.title || entry.profileTitle || "未命名岗位"),
      category: compactText(profile.category || entry.profileCategory || "未分类")
    },
    matchScore: Number(entry.matchScore ?? 0),
    recommendation: compactText(entry.recommendation || "需要人工复核"),
    copyableConclusion: compactText(entry.copyableConclusion || "").slice(0, 320),
    analysis: entry.analysis && typeof entry.analysis === "object" ? entry.analysis : null,
    batchResults: Array.isArray(entry.batchResults) ? entry.batchResults.slice(0, 50) : []
  };
}
