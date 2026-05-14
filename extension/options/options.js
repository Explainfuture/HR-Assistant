import { createJobProfileFromJD } from "../shared/deepseekClient.js";
import { formatJson, normalizeJobProfile, parseJsonLike } from "../shared/jsonUtils.js";
import {
  deleteJobProfile,
  getSettings,
  listJobProfiles,
  saveJobProfile,
  saveSettings
} from "../shared/storage.js";

const apiKeyInput = document.querySelector("#apiKeyInput");
const modelInput = document.querySelector("#modelInput");
const saveSettingsButton = document.querySelector("#saveSettingsButton");
const settingsStatus = document.querySelector("#settingsStatus");

const jdInput = document.querySelector("#jdInput");
const generateProfileButton = document.querySelector("#generateProfileButton");
const clearEditorButton = document.querySelector("#clearEditorButton");
const generateStatus = document.querySelector("#generateStatus");

const profileSelect = document.querySelector("#profileSelect");
const jsonEditor = document.querySelector("#jsonEditor");
const saveProfileButton = document.querySelector("#saveProfileButton");
const formatProfileButton = document.querySelector("#formatProfileButton");
const deleteProfileButton = document.querySelector("#deleteProfileButton");
const profileStatus = document.querySelector("#profileStatus");

let profiles = [];

init();

async function init() {
  const settings = await getSettings();
  apiKeyInput.value = settings.apiKey;
  modelInput.value = settings.model;
  await refreshProfiles();
}

saveSettingsButton.addEventListener("click", async () => {
  await runWithStatus(settingsStatus, async () => {
    await saveSettings({
      apiKey: apiKeyInput.value,
      model: modelInput.value
    });
    return "设置已保存";
  });
});

generateProfileButton.addEventListener("click", async () => {
  await runWithStatus(generateStatus, async () => {
    const jdText = jdInput.value.trim();
    if (!jdText) throw new Error("请先粘贴 JD 文本");

    const settings = await getSettings();
    if (!settings.apiKey) throw new Error("请先保存 DeepSeek API Key");

    setBusy(generateProfileButton, true, "生成中...");
    const profile = await createJobProfileFromJD({
      apiKey: settings.apiKey,
      model: settings.model,
      jdText
    });
    jsonEditor.value = formatJson(profile);
    profileSelect.value = "";
    return "已生成，可检查后保存";
  }).finally(() => setBusy(generateProfileButton, false, "生成岗位 JSON"));
});

clearEditorButton.addEventListener("click", () => {
  jdInput.value = "";
  jsonEditor.value = "";
  profileSelect.value = "";
  setStatus(generateStatus, "");
  setStatus(profileStatus, "");
});

profileSelect.addEventListener("change", () => {
  const selected = profiles.find((item) => item.id === profileSelect.value);
  jsonEditor.value = selected ? formatJson(selected) : "";
  setStatus(profileStatus, "");
});

formatProfileButton.addEventListener("click", () => {
  try {
    jsonEditor.value = formatJson(parseJsonLike(jsonEditor.value));
    setStatus(profileStatus, "JSON 已格式化", "success");
  } catch (error) {
    setStatus(profileStatus, error.message, "error");
  }
});

saveProfileButton.addEventListener("click", async () => {
  await runWithStatus(profileStatus, async () => {
    const parsed = parseJsonLike(jsonEditor.value);
    const profile = normalizeJobProfile(parsed, jdInput.value);
    if (!profile.title) throw new Error("岗位 title 不能为空");

    await saveJobProfile(profile);
    jsonEditor.value = formatJson(profile);
    await refreshProfiles(profile.id);
    return "岗位已保存";
  });
});

deleteProfileButton.addEventListener("click", async () => {
  await runWithStatus(profileStatus, async () => {
    const selectedId = profileSelect.value || parseJsonLike(jsonEditor.value).id;
    if (!selectedId) throw new Error("请选择要删除的岗位");
    await deleteJobProfile(selectedId);
    jsonEditor.value = "";
    await refreshProfiles();
    return "岗位已删除";
  });
});

async function refreshProfiles(selectedId = "") {
  profiles = await listJobProfiles();
  profileSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "选择已保存岗位" : "暂无岗位，请先新增";
  profileSelect.append(placeholder);

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.title || "未命名岗位";
    profileSelect.append(option);
  }

  if (selectedId) {
    profileSelect.value = selectedId;
  }
}

async function runWithStatus(node, task) {
  try {
    setStatus(node, "处理中...");
    const message = await task();
    setStatus(node, message, "success");
  } catch (error) {
    setStatus(node, error.message || String(error), "error");
  }
}

function setStatus(node, message, type = "") {
  node.textContent = message;
  node.className = `status ${type}`.trim();
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.textContent = label;
}
