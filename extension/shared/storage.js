const SETTINGS_KEY = "resumeCopilot.settings";
const JOB_PROFILES_KEY = "resumeCopilot.jobProfiles";

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
  return Array.isArray(result[JOB_PROFILES_KEY]) ? result[JOB_PROFILES_KEY] : [];
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
