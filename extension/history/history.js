import {
  clearAnalysisHistory,
  deleteAnalysisHistoryEntry,
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
  if (!selectedEntry) return;

  const label = selectedEntry.candidateName || selectedEntry.profile?.title || "该候选人";
  if (!confirm(`确定删除“${label}”的解析历史？此操作无法撤销。`)) return;

  const deletedId = selectedEntry.id;
  const deletedIndex = historyEntries.findIndex((entry) => entry.id === deletedId);
  historyEntries = await deleteAnalysisHistoryEntry(deletedId);
  selectedEntry = historyEntries[deletedIndex] || historyEntries[deletedIndex - 1] || historyEntries[0] || null;
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
  renderHistoryList();
  renderSelectedEntry();
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
    button.setAttribute("aria-pressed", String(entry.id === selectedEntry?.id));
    button.addEventListener("click", () => {
      updateWithTransition(() => {
        selectedEntry = entry;
        render();
      });
    });

    const nameRow = document.createElement("span");
    nameRow.className = "candidate-name-row";

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

function renderSelectedEntry() {
  reportRoot.innerHTML = "";
  copyConclusionButton.disabled = !selectedEntry?.copyableConclusion;
  renameCandidateButton.disabled = !selectedEntry;
  deleteCandidateButton.disabled = !selectedEntry;

  if (!selectedEntry) {
    detailTitle.textContent = "解析详情";
    detailMeta.textContent = "选择一位候选人查看报告。";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "暂无可查看的解析报告。";
    reportRoot.append(empty);
    return;
  }

  detailTitle.textContent = selectedEntry.candidateName || "姓名未识别";
  detailMeta.textContent = [
    formatHistoryTime(selectedEntry.createdAt),
    selectedEntry.source,
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
