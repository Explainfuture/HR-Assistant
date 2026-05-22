import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compactText,
  ensureArray,
  formatJson,
  normalizeJobCategory,
  normalizeAnalysis,
  parseJsonLike
} from "../extension/shared/jsonUtils.js";
import {
  inferCandidateName,
  isCandidateNameRecognized
} from "../extension/shared/candidateUtils.js";
import { extractDoubaoResponseText } from "../extension/shared/deepseekClient.js";
import {
  deleteAnalysisHistoryEntries,
  listAnalysisTasks,
  listAnalysisHistory
} from "../extension/shared/storage.js";
import { ERROR_TYPES, classifyError } from "../extension/shared/errorUtils.js";
import { shouldRenderPdfPageImages } from "../extension/shared/pdfPolicy.js";

const root = process.cwd();
const manifestPath = join(root, "extension", "manifest.json");

assert.equal(existsSync(manifestPath), true, "manifest.json should exist");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3, "manifest should use MV3");
assert.equal(manifest.permissions.includes("storage"), true, "storage permission is required");
assert.equal(manifest.permissions.includes("sidePanel"), true, "sidePanel permission is required");
assert.equal(manifest.permissions.includes("tabs"), true, "tabs permission is required");
assert.equal(
  manifest.host_permissions.includes("https://ark.cn-beijing.volces.com/*"),
  true,
  "Doubao host permission is required"
);
assert.equal(
  manifest.host_permissions.includes("https://*.mokahr.com/*"),
  true,
  "Moka host permission is required"
);
assert.equal(
  readFileSync(join(root, "extension/shared/deepseekClient.js"), "utf8").includes('const DEFAULT_REASONING_EFFORT = "high";'),
  true,
  "Doubao reasoning effort should stay high"
);
const pdfTextExtractorSource = readFileSync(join(root, "extension/shared/pdfTextExtractor.js"), "utf8");
assert.equal(pdfTextExtractorSource.includes("renderPageToImageUrl"), true, "PDF pages should render to images for OCR");
assert.equal(pdfTextExtractorSource.includes("imageUrls"), true, "PDF extractor should return rendered page images");
assert.equal(pdfTextExtractorSource.includes("shouldRenderPdfPageImages"), true, "PDF image rendering should be conditional");
assert.equal(pdfTextExtractorSource.includes("cMapUrl"), true, "PDF extractor should configure CMap assets");
assert.equal(pdfTextExtractorSource.includes("PDFJS_VERBOSITY_ERRORS"), true, "PDF extractor should suppress non-fatal PDF.js warnings");
assert.equal(existsSync(join(root, "extension/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap")), true, "PDF CMap assets should be bundled");
assert.equal(existsSync(join(root, "extension/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf")), true, "PDF standard fonts should be bundled");
const historySource = readFileSync(join(root, "extension/history/history.js"), "utf8");
assert.equal(historySource.includes("deleteAnalysisHistoryEntries"), true, "History should support batch deletion");
assert.equal(historySource.includes("isDeleteSelectionMode"), true, "History should support delete selection mode");
assert.equal(historySource.includes("???"), false, "History delete UI should not contain placeholder question marks");
const reportRendererSource = readFileSync(join(root, "extension/shared/reportRenderer.js"), "utf8");
assert.equal(reportRendererSource.includes("score-evidence"), true, "Analysis report should render resume evidence");
assert.equal(reportRendererSource.includes("confidence:"), true, "Analysis report should render evidence confidence");
const storageSource = readFileSync(join(root, "extension/shared/storage.js"), "utf8");
assert.equal(storageSource.includes("entry.id || entry.taskId"), true, "History entries should use taskId as a stable id fallback");
assert.equal(storageSource.includes("!targetIds.has(entry.taskId)"), true, "Batch deletion should match old history entries by taskId");
assert.equal(storageSource.includes("resumeCopilot.analysisTasks"), true, "Task status should be persisted for MV3 recovery");
const backgroundSource = readFileSync(join(root, "extension/background.js"), "utf8");
assert.equal(backgroundSource.includes("hydratePersistedTasks"), true, "Background should hydrate persisted tasks");
assert.equal(backgroundSource.includes("TASK_INTERRUPTED"), true, "Background should mark interrupted tasks after recovery");
const mockChromeStorage = {
  "resumeCopilot.analysisHistory": [
    {
      taskId: "legacy-task-1",
      createdAt: "2026-05-22T08:00:00.000Z",
      candidateName: "张三",
      profile: { title: "数据标注师", category: "研发" },
      analysis: {}
    }
  ]
};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: mockChromeStorage[key] };
      },
      async set(value) {
        Object.assign(mockChromeStorage, value);
      },
      async remove(key) {
        delete mockChromeStorage[key];
      }
    }
  }
};
const legacyHistory = await listAnalysisHistory();
assert.equal(legacyHistory[0].id, "legacy-task-1", "Legacy history should use taskId as stable id");
await deleteAnalysisHistoryEntries([legacyHistory[0].id]);
assert.equal((await listAnalysisHistory()).length, 0, "Batch deletion should remove legacy taskId-only history");
mockChromeStorage["resumeCopilot.analysisTasks"] = [
  { id: "task-1", status: "running", createdAt: "2026-05-22T08:00:00.000Z", updatedAt: "2026-05-22T08:00:00.000Z" }
];
assert.equal((await listAnalysisTasks())[0].id, "task-1", "Persisted task status should be readable");
delete globalThis.chrome;
assert.equal(shouldRenderPdfPageImages("短文本"), true, "Short PDF text should render images for OCR");
assert.equal(shouldRenderPdfPageImages("候选人".repeat(300)), false, "Long PDF text should skip image OCR");
assert.equal(classifyError("Doubao 返回为空"), ERROR_TYPES.MODEL_EMPTY_RESPONSE);
assert.equal(classifyError("任务被浏览器回收中断"), ERROR_TYPES.TASK_INTERRUPTED);

const requiredFiles = [
  "extension/background.js",
  "extension/options/options.html",
  "extension/options/options.css",
  "extension/options/options.js",
  "extension/history/history.html",
  "extension/history/history.css",
  "extension/history/history.js",
  "extension/sidepanel/sidepanel.html",
  "extension/sidepanel/sidepanel.css",
  "extension/sidepanel/sidepanel.js",
  "extension/content/bossResumeExtractor.js",
  "extension/shared/storage.js",
  "extension/shared/deepseekClient.js",
  "extension/shared/prompts.js",
  "extension/shared/jsonUtils.js",
  "extension/shared/candidateUtils.js",
  "extension/shared/pdfTextExtractor.js",
  "extension/shared/pdfPolicy.js",
  "extension/shared/errorUtils.js",
  "extension/shared/reportRenderer.js",
  "extension/shared/viewTransitions.js",
  "extension/shared/ui.css",
  "extension/vendor/pdfjs/pdf.min.mjs",
  "extension/vendor/pdfjs/pdf.worker.min.mjs"
];

for (const file of requiredFiles) {
  assert.equal(existsSync(join(root, file)), true, `${file} should exist`);
}

assert.deepEqual(parseJsonLike('{"ok":true}'), { ok: true });
assert.deepEqual(parseJsonLike('```json\n{"ok":true}\n```'), { ok: true });
assert.deepEqual(parseJsonLike('模型输出：{"ok":true,"items":[1,2]}'), {
  ok: true,
  items: [1, 2]
});
assert.deepEqual(parseJsonLike(`模型输出：{"title":"AI Agent
评测","mustHave":["Claude
Cursor	Codex"]}`), {
  title: "AI Agent\n评测",
  mustHave: ["Claude\nCursor\tCodex"]
});
assert.equal(formatJson({ ok: true }), '{\n  "ok": true\n}');
assert.equal(compactText("a\\nb\nc\t d"), "a b c d");
assert.equal(normalizeJobCategory("", "品牌投放经理", ""), "市场");
assert.equal(normalizeJobCategory("销售", "Java 工程师", ""), "销售");
assert.deepEqual(ensureArray([{ project: "Agent eval", reason: "Strong evidence\\nwith detail" }]), [
  { project: "Agent eval", reason: "Strong evidence with detail" }
]);
assert.equal(
  inferCandidateName(
    "ccassiduous 22岁 | 27年应届生 | 本科\\n985后端开发java\\n工作/实习经历\\n九坤投资\\n前端开发工程师"
  ),
  "ccassiduous"
);
assert.equal(
  inferCandidateName(
    "John Smith\\nSenior Frontend Engineer\\njohn.smith@example.com\\nWork Experience\\nAcme Technology Inc"
  ),
  "John Smith"
);
assert.equal(
  inferCandidateName(
    "Name: Mary Ann Lee\\nProduct Manager\\nEducation\\nUniversity of California"
  ),
  "Mary Ann Lee"
);
assert.equal(isCandidateNameRecognized("ccassiduous"), true);
assert.equal(isCandidateNameRecognized("John Smith"), true);
assert.equal(isCandidateNameRecognized("九坤投资"), false);
assert.equal(isCandidateNameRecognized("Senior Frontend Engineer"), false);
assert.equal(isCandidateNameRecognized("Acme Technology Inc"), false);

assert.equal(
  extractDoubaoResponseText({
    output: [
      {
        type: "reasoning",
        summary: [{ text: "reasoning summary" }]
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: '{"title":"数据标注师"}' }]
      }
    ]
  }),
  '{"title":"数据标注师"}'
);
assert.equal(
  extractDoubaoResponseText({
    choices: [{ message: { content: '{"title":"兼容式响应"}' } }]
  }),
  '{"title":"兼容式响应"}'
);
const sparseAnalysis = normalizeAnalysis(
  {
    matchedRole: { recommendation: "建议淘汰" },
    scoreBreakdown: {
      internalRequirements: { score: 0, maxScore: 30, reason: "岗位内部定制需求为空，无匹配基础" },
      coreExperience: { score: 0, maxScore: 30, reason: "候选人核心经历均为后端开发，无数据标注相关核心经验" },
      keySkills: { score: 0, maxScore: 15, reason: "无数据标注、数据分类等岗位关键技能" },
      stability: { score: 0, maxScore: 10, reason: "无明确信息显示有充足时间参与兼职" },
      businessUnderstanding: { score: 0, maxScore: 15, reason: "无数据标注相关业务认知" }
    }
  },
  { id: "profile-1", title: "数据标注师" }
);
assert.ok(sparseAnalysis.experienceAnalysis.oneLineProfile.includes("数据标注师"));
assert.ok(sparseAnalysis.experienceAnalysis.mismatchedProjects.length > 0);
assert.ok(sparseAnalysis.elimination.reasons.length > 0);
assert.ok(sparseAnalysis.interviewQuestions.length > 0);
assert.ok(sparseAnalysis.copyableConclusion.includes("建议淘汰"));

const javascriptFiles = requiredFiles.filter((file) => /\.(mjs|js)$/.test(file));
for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
}

console.log("Extension validation passed.");
