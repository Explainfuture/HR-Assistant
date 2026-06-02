import {
  clearAnalysisHistory,
  deleteAnalysisHistoryEntries,
  listAnalysisHistory,
  updateAnalysisHistoryEntry
} from "../shared/storage.js";
import { isCandidateNameRecognized } from "../shared/candidateUtils.js";
import { renderAnalysisReport } from "../shared/reportRenderer.js";
import { markEntered, updateWithTransition } from "../shared/viewTransitions.js";

const historySummary = document.querySelector("#historySummary");
const candidateCount = document.querySelector("#candidateCount");
const historyList = document.querySelector("#historyList");
const detailTitle = document.querySelector("#detailTitle");
const detailMeta = document.querySelector("#detailMeta");
const reportRoot = document.querySelector("#reportRoot");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const renameCandidateButton = document.querySelector("#renameCandidateButton");
const deleteCandidateButton = document.querySelector("#deleteCandidateButton");
const copyConclusionButton = document.querySelector("#copyConclusionButton");

let historyEntries = [];
let selectedEntry = null;
let isDeleteSelectionMode = false;
let selectedDeleteIds = new Set();

init();

closeHistoryButton.addEventListener("click", () => {
  window.close();
  window.setTimeout(() => {
    if (history.length > 1) history.back();
  }, 120);
});

clearHistoryButton.addEventListener("click", async () => {
  if (!historyEntries.length) return;
  if (!confirm("确定清空所有候选人解析历史？此操作无法撤销。")) return;

  historyEntries = await clearAnalysisHistory();
  selectedEntry = null;
  exitDeleteSelectionMode();
  render();
});

copyConclusionButton.addEventListener("click", async () => {
  if (!selectedEntry?.copyableConclusion) return;
  await navigator.clipboard.writeText(selectedEntry.copyableConclusion);
  copyConclusionButton.textContent = "已复制";
  window.setTimeout(() => {
    copyConclusionButton.textContent = "复制备注总结";
  }, 1400);
});

renameCandidateButton.addEventListener("click", async () => {
  if (!selectedEntry) return;
  const nextName = prompt("请输入候选人真实姓名", selectedEntry.candidateName || "");
  if (nextName == null) return;
  if (!isCandidateNameRecognized(nextName)) {
    alert("请输入 2-6 个中文字符的真实姓名，不要填写页面按钮文案。");
    return;
  }

  historyEntries = await updateAnalysisHistoryEntry(selectedEntry.id, {
    candidateName: nextName
  });
  selectedEntry = historyEntries.find((entry) => entry.id === selectedEntry.id) || historyEntries[0] || null;
  render();
});

deleteCandidateButton.addEventListener("click", async () => {
  if (!isDeleteSelectionMode) {
    enterDeleteSelectionMode();
    render();
    return;
  }

  if (!selectedDeleteIds.size) {
    exitDeleteSelectionMode();
    render();
    return;
  }

  const count = selectedDeleteIds.size;
  if (!confirm(`确定删除已选 ${count} 条候选人解析记录？此操作无法撤销。`)) return;

  const previousSelectedId = selectedEntry?.id || "";
  historyEntries = await deleteAnalysisHistoryEntries([...selectedDeleteIds]);
  selectedEntry = historyEntries.find((entry) => entry.id === previousSelectedId) || historyEntries[0] || null;
  exitDeleteSelectionMode();
  render();
});

async function init() {
  historyEntries = await listAnalysisHistory();
  selectedEntry = historyEntries[0] || null;
  render();
}

function render() {
  candidateCount.textContent = String(historyEntries.length);
  historySummary.textContent = historyEntries.length
    ? `本地保留最近 ${historyEntries.length} 位候选人的解析结果。`
    : "暂无本地候选人解析历史。";
  clearHistoryButton.disabled = !historyEntries.length;
  updateDeleteActions();
  renderHistoryList();
  renderSelectedEntry();
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
    console.warn(error);
  }
}

function renderHistoryList() {
  historyList.innerHTML = "";

  if (!historyEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "暂无候选人历史。";
    historyList.append(empty);
    return;
  }

  for (const entry of historyEntries) {
    const button = document.createElement("button");
    button.className = "candidate-item";
    button.type = "button";
    button.setAttribute("aria-pressed", String(!isDeleteSelectionMode && entry.id === selectedEntry?.id));
    if (isDeleteSelectionMode) {
      button.classList.add("selectable");
      button.setAttribute("aria-selected", String(selectedDeleteIds.has(entry.id)));
    }
    button.addEventListener("click", () => {
      if (isDeleteSelectionMode) {
        toggleDeleteSelection(entry.id);
        render();
        return;
      }
      updateWithTransition(() => {
        selectedEntry = entry;
        render();
      });
      syncMokaCandidatePage(entry);
    });

    const nameRow = document.createElement("span");
    nameRow.className = "candidate-name-row";

    if (isDeleteSelectionMode) {
      const checkbox = document.createElement("span");
      checkbox.className = "candidate-check";
      checkbox.textContent = selectedDeleteIds.has(entry.id) ? "✓" : "";
      nameRow.append(checkbox);
    }

    const name = document.createElement("span");
    name.className = "candidate-name";
    name.textContent = entry.candidateName || "姓名未识别";

    const score = document.createElement("span");
    score.className = "candidate-score";
    score.textContent = Number.isFinite(Number(entry.matchScore)) ? `${Number(entry.matchScore)}` : "-";

    nameRow.append(name, score);

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

    button.append(nameRow, meta, recommendation);
    historyList.append(button);
  }
}

function enterDeleteSelectionMode() {
  isDeleteSelectionMode = true;
  selectedDeleteIds = new Set(selectedEntry?.id ? [selectedEntry.id] : []);
}

function exitDeleteSelectionMode() {
  isDeleteSelectionMode = false;
  selectedDeleteIds = new Set();
}

function toggleDeleteSelection(id) {
  if (selectedDeleteIds.has(id)) {
    selectedDeleteIds.delete(id);
  } else {
    selectedDeleteIds.add(id);
  }
}

function updateDeleteActions() {
  if (isDeleteSelectionMode) {
    deleteCandidateButton.textContent = selectedDeleteIds.size
      ? `删除已选 ${selectedDeleteIds.size} 条`
      : "取消删除";
    renameCandidateButton.disabled = true;
    copyConclusionButton.disabled = true;
    clearHistoryButton.disabled = true;
    return;
  }

  deleteCandidateButton.textContent = "删除该记录";
}

function renderSelectedEntry() {
  reportRoot.innerHTML = "";
  copyConclusionButton.disabled = isDeleteSelectionMode || !selectedEntry?.copyableConclusion;
  renameCandidateButton.disabled = isDeleteSelectionMode || !selectedEntry;
  deleteCandidateButton.disabled = !historyEntries.length;

  if (!selectedEntry) {
    detailTitle.textContent = isDeleteSelectionMode ? "选择要删除的记录" : "暂无记录";
    detailMeta.textContent = isDeleteSelectionMode ? "勾选候选人后点击删除按钮确认。" : "暂无候选人解析历史。";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "暂无候选人历史。";
    reportRoot.append(empty);
    return;
  }

  if (isDeleteSelectionMode) {
    detailTitle.textContent = "选择要删除的记录";
    detailMeta.textContent = selectedDeleteIds.size
      ? `已选择 ${selectedDeleteIds.size} 条候选人解析记录。`
      : "点击左侧候选人记录进行多选。";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "删除模式下暂不显示解析详情。";
    reportRoot.append(empty);
    return;
  }

  detailTitle.textContent = selectedEntry.candidateName || "姓名未识别";
  detailMeta.textContent = [
    formatHistoryTime(selectedEntry.createdAt),
    selectedEntry.source,
    selectedEntry.mokaPositionTitle,
    selectedEntry.profile?.category,
    selectedEntry.profile?.title,
    selectedEntry.recommendation
  ]
    .filter(Boolean)
    .join(" · ");

  renderReport(selectedEntry.analysis, selectedEntry.batchResults || []);
}

function renderReport(analysis, batchResults = []) {
  reportRoot.append(
    renderAnalysisReport({
      analysis,
      batchResults,
      fallbackProfileTitle: selectedEntry?.profile?.title || "未命名岗位",
      fallbackScore: selectedEntry?.matchScore,
      fallbackRecommendation: selectedEntry?.recommendation,
      copyableConclusion: selectedEntry?.copyableConclusion || "",
      headingLevel: 3
    })
  );
  markEntered(reportRoot);
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
