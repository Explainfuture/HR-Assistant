import { createJobProfileFromJD } from "../shared/deepseekClient.js";
import {
  formatJson,
  JOB_CATEGORIES,
  normalizeJobProfile,
  parseJsonLike
} from "../shared/jsonUtils.js";
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
const closeOptionsButton = document.querySelector("#closeOptionsButton");

const jdInput = document.querySelector("#jdInput");
const internalRequirementsInput = document.querySelector("#internalRequirementsInput");
const generateProfileButton = document.querySelector("#generateProfileButton");
const clearEditorButton = document.querySelector("#clearEditorButton");
const generateStatus = document.querySelector("#generateStatus");

const profileSelect = document.querySelector("#profileSelect");
const categorySelect = document.querySelector("#categorySelect");
const jsonEditor = document.querySelector("#jsonEditor");
const saveProfileButton = document.querySelector("#saveProfileButton");
const formatProfileButton = document.querySelector("#formatProfileButton");
const deleteProfileButton = document.querySelector("#deleteProfileButton");
const profileStatus = document.querySelector("#profileStatus");

let profiles = [];

init();

closeOptionsButton.addEventListener("click", () => {
  window.close();
  window.setTimeout(() => {
    if (history.length > 1) history.back();
  }, 120);
});

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

    setBusy(generateProfileButton, true, "生成中…");
    const profile = await createJobProfileFromJD({
      apiKey: settings.apiKey,
      model: settings.model,
      jdText,
      internalRequirements: internalRequirementsInput.value.trim()
    });
    jsonEditor.value = formatJson(profile);
    profileSelect.value = "";
    categorySelect.value = profile.category || "";
    return "已生成，可检查后保存";
  }).finally(() => setBusy(generateProfileButton, false, "生成岗位 JSON"));
});

clearEditorButton.addEventListener("click", () => {
  jdInput.value = "";
  internalRequirementsInput.value = "";
  jsonEditor.value = "";
  profileSelect.value = "";
  categorySelect.value = "";
  setStatus(generateStatus, "");
  setStatus(profileStatus, "");
});

profileSelect.addEventListener("change", () => {
  const selected = profiles.find((item) => item.id === profileSelect.value);
  jsonEditor.value = selected ? formatJson(normalizeJobProfile(selected)) : "";
  jdInput.value = selected?.jd || "";
  internalRequirementsInput.value = selected?.internalRequirements || "";
  categorySelect.value = selected?.category || "";
  setStatus(profileStatus, "");
});

categorySelect.addEventListener("change", () => {
  try {
    const parsed = jsonEditor.value ? parseJsonLike(jsonEditor.value) : {};
    jsonEditor.value = formatJson(
      normalizeJobProfile({
        ...parsed,
        category: categorySelect.value || parsed.category
      })
    );
    setStatus(profileStatus, "岗位大类已更新，保存后生效", "success");
  } catch (error) {
    setStatus(profileStatus, error.message, "error");
  }
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
    const profile = normalizeJobProfile(
      {
        ...parsed,
        internalRequirements: internalRequirementsInput.value.trim()
      },
      jdInput.value
    );
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
    const selected = profiles.find((item) => item.id === selectedId);
    const title = selected?.title || "当前岗位";
    if (!confirm(`确定删除“${title}”？此操作无法撤销。`)) {
      return "已取消删除";
    }
    await deleteJobProfile(selectedId);
    jsonEditor.value = "";
    await refreshProfiles();
    return "岗位已删除";
  });
});

async function refreshProfiles(selectedId = "") {
  profiles = await listJobProfiles();
  renderCategoryOptions();
  profileSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "选择已保存岗位" : "暂无岗位，请先新增";
  profileSelect.append(placeholder);

  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.title || "未命名岗位"} · ${profile.category || "未分类"}`;
    profileSelect.append(option);
  }

  if (selectedId) {
    profileSelect.value = selectedId;
    const selected = profiles.find((item) => item.id === selectedId);
    categorySelect.value = selected?.category || "";
  }
}

function renderCategoryOptions() {
  categorySelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择岗位大类";
  categorySelect.append(placeholder);

  for (const category of JOB_CATEGORIES) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    categorySelect.append(option);
  }
}

async function runWithStatus(node, task) {
  try {
    setStatus(node, "处理中…");
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
