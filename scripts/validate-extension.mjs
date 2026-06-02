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
  isCandidateNameRecognized,
  isResumeTagLikeCandidateName
} from "../extension/shared/candidateUtils.js";
import { extractDoubaoResponseText } from "../extension/shared/deepseekClient.js";
import {
  deleteAnalysisHistoryEntries,
  exportResumeCopilotData,
  importResumeCopilotData,
  listAnalysisTasks,
  listAnalysisHistory,
  saveAnalysisHistoryEntry
} from "../extension/shared/storage.js";
import { ERROR_TYPES, classifyError } from "../extension/shared/errorUtils.js";
import { shouldRenderPdfPageImages } from "../extension/shared/pdfPolicy.js";
import { createResumeFingerprint } from "../extension/shared/resumeFingerprint.js";
import {
  getMokaApplicationId,
  getMokaDetailUrl,
  getResumePageKey,
  isSupportedResumePage
} from "../extension/shared/pagePolicy.js";

const root = process.cwd();
const manifestPath = join(root, "extension", "manifest.json");

assert.equal(existsSync(manifestPath), true, "manifest.json should exist");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3, "manifest should use MV3");
assert.equal(manifest.permissions.includes("storage"), true, "storage permission is required");
assert.equal(manifest.permissions.includes("sidePanel"), true, "sidePanel permission is required");
assert.equal(manifest.permissions.includes("tabs"), true, "tabs permission is required");
assert.equal(manifest.permissions.includes("scripting"), true, "scripting permission is required for Moka header fallback extraction");
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
  "Job matching reasoning effort should stay high"
);
assert.equal(
  readFileSync(join(root, "extension/shared/deepseekClient.js"), "utf8").includes('const OCR_REASONING_EFFORT = "low";'),
  true,
  "Image OCR should use low reasoning effort for speed"
);
const pdfTextExtractorSource = readFileSync(join(root, "extension/shared/pdfTextExtractor.js"), "utf8");
assert.equal(pdfTextExtractorSource.includes("renderPageToImageUrl"), true, "PDF pages should render to images for OCR");
assert.equal(pdfTextExtractorSource.includes("imageUrls"), true, "PDF extractor should return rendered page images");
assert.equal(pdfTextExtractorSource.includes("MAX_RENDERED_PAGES"), false, "PDF image rendering should include every page");
assert.equal(pdfTextExtractorSource.includes("Math.min(pdf.numPages"), false, "PDF image rendering should not truncate pages");
assert.equal(pdfTextExtractorSource.includes("cMapUrl"), true, "PDF extractor should configure CMap assets");
assert.equal(pdfTextExtractorSource.includes("PDFJS_VERBOSITY_ERRORS"), true, "PDF extractor should suppress non-fatal PDF.js warnings");
assert.equal(existsSync(join(root, "extension/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap")), true, "PDF CMap assets should be bundled");
assert.equal(existsSync(join(root, "extension/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf")), true, "PDF standard fonts should be bundled");
const historySource = readFileSync(join(root, "extension/history/history.js"), "utf8");
assert.equal(historySource.includes("deleteAnalysisHistoryEntries"), true, "History should support batch deletion");
assert.equal(historySource.includes("isDeleteSelectionMode"), true, "History should support delete selection mode");
assert.equal(historySource.includes("???"), false, "History delete UI should not contain placeholder question marks");
const sidepanelHtmlSource = readFileSync(join(root, "extension/sidepanel/sidepanel.html"), "utf8");
assert.equal(sidepanelHtmlSource.includes("queueStatusText"), true, "Side panel should show inline queue status");
assert.equal(sidepanelHtmlSource.includes("historyPrevButton"), true, "Side panel history should support pagination");
assert.equal(sidepanelHtmlSource.includes("pdfFileStatus"), true, "PDF upload should show the selected file name");
assert.equal(sidepanelHtmlSource.includes("captureBlock"), false, "Side panel should not render recent submission cards");
assert.equal(sidepanelHtmlSource.includes("taskList"), false, "Side panel should not render background task cards");
const sidepanelCssSource = readFileSync(join(root, "extension/sidepanel/sidepanel.css"), "utf8");
assert.equal(sidepanelCssSource.includes("content-visibility"), false, "Candidate history cards should not use stale intrinsic sizing");
assert.equal(sidepanelCssSource.includes("min-height: 92px"), true, "Candidate history cards should reserve enough height");
assert.equal(sidepanelCssSource.includes("-webkit-line-clamp: 2"), true, "Candidate metadata should clamp instead of overflowing");
assert.equal(sidepanelCssSource.includes(".file-status.success"), true, "PDF upload selected state should be styled");
const sidepanelSource = readFileSync(join(root, "extension/sidepanel/sidepanel.js"), "utf8");
assert.equal(sidepanelSource.includes("const HISTORY_PAGE_SIZE = 10;"), true, "Candidate history should paginate every 10 entries");
assert.equal(sidepanelSource.includes("renderQueueStatus"), true, "Side panel should summarize tasks inline");
assert.equal(sidepanelSource.includes("OFFER_LOCATION_OPTIONS"), false, "Offer template should not render the old manual location grid");
assert.equal(sidepanelSource.includes("复制Offer申请"), true, "Offer template should support one-click copy");
assert.equal(sidepanelSource.includes("Offer申请模板"), true, "Side panel should render the offer application template");
assert.equal(sidepanelSource.includes("离职原因"), false, "Offer template should not render old departure reason fields");
assert.equal(sidepanelSource.includes("目前薪资"), false, "Offer template should not render old salary fields");
assert.equal(sidepanelSource.includes("formatOfferGenderAge"), true, "Offer basic info should split gender and age with semicolons");
assert.equal(sidepanelSource.includes("简历采集调试"), true, "Side panel should expose resume extraction diagnostics");
assert.equal(sidepanelSource.includes("findResumeKeywordHits"), true, "Resume diagnostics should show project/experience keyword hits");
assert.equal(sidepanelSource.includes("lastAutoPageKey"), true, "Auto capture should track the active Moka detail page key");
assert.equal(sidepanelSource.includes("if (pageKey && pageKey === lastAutoPageKey) return"), false, "Auto capture should not skip Moka collection before lazy pdf-resume images load");
assert.equal(sidepanelSource.includes("lastAutoFingerprint && pageKey && pageKey === lastAutoPageKey"), true, "Auto capture should skip repeated Moka pages only after a successful fingerprint");
assert.equal(sidepanelSource.includes("autoCaptureRerunRequested"), true, "Auto capture should rerun after an in-flight capture when the user switches candidates");
assert.equal(sidepanelSource.includes("AUTO_CAPTURE_TIMEOUT_MS"), true, "Auto capture should not stay locked forever if page extraction hangs");
assert.equal(sidepanelSource.includes("运行 ${runningCount}，排队 ${queuedCount}"), true, "Queue status should show running and queued task counts");
assert.equal(sidepanelSource.includes("等待简历图片加载"), true, "Auto capture should leave collecting state when Moka images are not ready");
assert.equal(sidepanelSource.includes("正在采集当前简历图片"), true, "Auto capture should show progress before background task submission");
assert.equal(sidepanelSource.includes("正在识别简历图片"), true, "Running tasks should show the OCR stage instead of a stuck 0/N counter");
assert.equal(sidepanelSource.includes("ocrFinished"), true, "Running tasks should show per-page OCR progress");
assert.equal(sidepanelSource.includes("renderPdfFileSelectionStatus"), true, "PDF upload should update status when a file is selected");
assert.equal(sidepanelSource.includes("已上传"), true, "PDF upload should show uploaded filename feedback");
const reportRendererSource = readFileSync(join(root, "extension/shared/reportRenderer.js"), "utf8");
assert.equal(reportRendererSource.includes("score-evidence"), true, "Analysis report should render resume evidence");
assert.equal(reportRendererSource.includes("判断依据："), true, "Analysis report should render confidence in Chinese");
assert.equal(reportRendererSource.includes("cleanReportText"), true, "Analysis report should hide placeholder null text from old history");
const storageSource = readFileSync(join(root, "extension/shared/storage.js"), "utf8");
assert.equal(storageSource.includes("entry.id || entry.taskId"), true, "History entries should use taskId as a stable id fallback");
assert.equal(storageSource.includes("!targetIds.has(entry.taskId)"), true, "Batch deletion should match old history entries by taskId");
assert.equal(storageSource.includes("resumeCopilot.analysisTasks"), true, "Task status should be persisted for MV3 recovery");
assert.equal(storageSource.includes("resumeFingerprint"), true, "History and task records should keep resume fingerprints");
assert.equal(storageSource.includes("offerApplication"), true, "History should persist offer application templates");
assert.equal(storageSource.includes("resumeImageCount"), true, "History should persist captured resume image count");
assert.equal(storageSource.includes("resumeExtractedTextLength"), true, "History should persist OCR merged text length");
assert.equal(storageSource.includes("stage: compactText(task.progress.stage"), true, "Persisted task progress should retain OCR/matching stage");
assert.equal(storageSource.includes("ocrFinished"), true, "Persisted task progress should retain per-page OCR progress");
assert.equal(storageSource.includes("exportResumeCopilotData"), true, "Storage should support full config export");
assert.equal(storageSource.includes("importResumeCopilotData"), true, "Storage should support full config import");
const backgroundSource = readFileSync(join(root, "extension/background.js"), "utf8");
assert.equal(backgroundSource.includes("const TASK_CONCURRENCY = 10;"), true, "Background should run up to 10 candidate analyses concurrently");
assert.equal(backgroundSource.includes("hydratePersistedTasks"), true, "Background should hydrate persisted tasks");
assert.equal(backgroundSource.includes("TASK_INTERRUPTED"), true, "Background should mark interrupted tasks after recovery");
assert.equal(backgroundSource.includes("findDuplicateAnalysis"), true, "Background should dedupe already parsed resumes");
assert.equal(backgroundSource.includes("RESUME_COPILOT_GENERATE_OFFER_APPLICATION"), true, "Background should generate offer templates");
assert.equal(backgroundSource.includes("buildAutomaticOfferApplication"), true, "Background should automatically generate offer templates after analysis");
assert.equal(backgroundSource.includes("resumeImageCount"), true, "Background should save resume capture diagnostics");
assert.equal(backgroundSource.includes("resumeCaptureDebug"), true, "Background should save detailed resume capture diagnostics");
assert.equal(backgroundSource.includes('stage: task.resume.imageUrls?.length ? "ocr" : "matching"'), true, "Background should mark OCR stage before image resume analysis");
assert.equal(backgroundSource.includes("ocrFinished"), true, "Background should persist per-page OCR progress");
assert.equal(backgroundSource.includes("slice(0, 8)"), false, "Background should not truncate resume images");
assert.equal(backgroundSource.includes("请打开 Moka 候选人详情页后再解析"), true, "Background should reject Moka list-page submissions");
assert.equal(backgroundSource.includes("isResumeTagLikeCandidateName"), true, "Background should reject Moka tab labels as candidate names");
assert.equal(backgroundSource.includes("/moka/i.test(source) && isCandidateNameRecognized(rawCandidateName)"), true, "Moka submissions should keep the header candidate name instead of re-inferring from page text");
assert.equal(backgroundSource.includes("shouldLockSubmittedCandidateName"), true, "Moka page candidate names should not be overwritten by OCR");
assert.equal(backgroundSource.includes("formatOfferGenderAge"), true, "Automatic offer content should format gender and age separately");
assert.equal(backgroundSource.includes("RESUME_COPILOT_OPEN_MOKA_CANDIDATE"), true, "Background should open stored Moka candidate pages");
assert.equal(backgroundSource.includes("mokaPositionTitle: task.resume.mokaPositionTitle"), true, "History should persist Moka header position");
assert.equal(backgroundSource.includes("generatedFields.positioning = mokaPositionTitle"), true, "Offer positioning should prefer Moka header position");
const extractorSource = readFileSync(join(root, "extension/content/bossResumeExtractor.js"), "utf8");
assert.equal(extractorSource.includes("isMokaCandidateListPage"), true, "Content extractor should ignore Moka candidate list pages");
assert.equal(extractorSource.includes("collectPdfResumeImageCandidates"), true, "Content extractor should prioritize Moka pdf-resume image pages");
assert.equal(extractorSource.includes("collectDirectPdfResumeImageCandidates"), true, "Content extractor should directly read Moka pdf-resume img tags");
assert.equal(extractorSource.includes("MOKA_MAX_SCROLL_ROUNDS"), true, "Moka pdf-resume collection should not run the long generic scroll loop");
assert.equal(extractorSource.includes("isMokaResumeImageUrl"), true, "Moka pdf-resume images should be passed as URLs without content-script fetch conversion");
assert.equal(extractorSource.includes("Moka 简历图片还未加载完成"), true, "Moka collection should not submit text-only stale captures");
assert.equal(extractorSource.includes("extractMokaCandidateIdentity"), true, "Content extractor should collect Moka header identity");
assert.equal(extractorSource.includes(".candidate-header-info"), true, "Moka name extraction should prioritize candidate-header-info");
assert.equal(extractorSource.includes("candidate-header-info__item-pandect-current"), true, "Moka position extraction should read the header info item");
assert.equal(extractorSource.includes("for (const headerRoot of document.querySelectorAll(\".candidate-header-info\"))"), true, "Moka position extraction should scan every visible header");
assert.equal(extractorSource.includes("mokaPositionTitle"), true, "Content extractor should return Moka header position");
assert.equal(extractorSource.includes("normalizeNameToken"), true, "Moka name extraction should strip header badges from name tokens");
assert.equal(extractorSource.includes(".pdf-resume"), true, "Content extractor should target Moka pdf-resume containers");
assert.equal(extractorSource.includes("pdfResumeImgTags"), true, "Content extractor should expose Moka pdf image tag diagnostics");
assert.equal(extractorSource.includes("return roots;"), true, "Moka pdf-resume roots should be scanned even when virtualized offscreen");
assert.equal(extractorSource.includes("MAX_RESUME_IMAGES"), false, "Content extractor should collect all resume images");
assert.equal(extractorSource.includes("MAX_SCROLL_ROUNDS = 40"), true, "Content extractor should scan long multi-page resumes");
const deepseekSource = readFileSync(join(root, "extension/shared/deepseekClient.js"), "utf8");
assert.equal(deepseekSource.includes("imageUrls.slice(0, 8)"), false, "Doubao calls should receive every collected resume image");
assert.equal(deepseekSource.includes("mergeRecognizedResumeText"), true, "OCR text should merge page text with recognized image sections");
assert.equal(deepseekSource.includes("parsed?.sections"), true, "OCR parsing should preserve section text when raw_text is sparse");
assert.equal(deepseekSource.includes("resumeExtractedText"), true, "Analysis should retain OCR text for automatic template generation");
assert.equal(deepseekSource.includes("fetchWithTimeout"), true, "Doubao calls should not leave analysis tasks running forever");
assert.equal(deepseekSource.includes('stage: "ocr"'), true, "Image OCR should emit a distinct progress stage");
assert.equal(deepseekSource.includes("IMAGE_RESPONSE_TIMEOUT_MS"), true, "Image OCR should use an explicit timeout");
assert.equal(deepseekSource.includes("OCR_REASONING_EFFORT"), true, "Image OCR should use a faster reasoning effort than job matching");
assert.equal(deepseekSource.includes("OCR_PAGE_CONCURRENCY"), true, "Image OCR should process pages concurrently");
assert.equal(deepseekSource.includes("recognizeResumeImagePage"), true, "Image OCR should split multi-page resumes into page-level requests");
assert.equal(sidepanelSource.includes("mokaDetailUrl: getMokaDetailUrl(tab.url)"), true, "Side panel should keep the current Moka detail URL");
assert.equal(sidepanelSource.includes("extractMokaHeaderMetadataFromTab"), true, "Side panel should fallback-read the active Moka header position");
assert.equal(sidepanelSource.includes("candidateName: mokaHeaderMetadata.candidateName"), true, "Side panel Moka header fallback should override noisy inferred candidate names");
assert.equal(sidepanelSource.includes("syncMokaCandidatePage(entry)"), true, "Side panel candidate cards should sync the active Moka page");
const historySourceForSync = readFileSync(join(root, "extension/history/history.js"), "utf8");
assert.equal(historySourceForSync.includes("syncMokaCandidatePage(entry)"), true, "History candidate cards should sync the active Moka page");
const promptsSource = readFileSync(join(root, "extension/shared/prompts.js"), "utf8");
assert.equal(promptsSource.includes('"genderAge"'), true, "Offer prompt should request gender and age first");
assert.equal(promptsSource.includes('"recentCompanyBackground"'), true, "Offer prompt should request recent company background");
assert.equal(promptsSource.includes("女；30岁；华中科技大学机械学院本科，同济大学设计创意学院硕士；小红书工作背景"), true, "Offer prompt should describe the expected basic info format");
const mockChromeStorage = {
  "resumeCopilot.analysisHistory": [
    {
      taskId: "legacy-fake-tag",
      resumeFingerprint: "rf_fake_tag",
      createdAt: "2026-05-22T08:06:00.000Z",
      candidateName: "QS50",
      profile: { title: "Java开发工程师", category: "研发" },
      analysis: {}
    },
    {
      taskId: "legacy-moka-tab",
      resumeFingerprint: "rf_moka_tab",
      createdAt: "2026-05-22T08:06:30.000Z",
      candidateName: "人才推荐",
      profile: { title: "Java开发工程师", category: "研发" },
      analysis: {}
    },
    {
      taskId: "legacy-moka-stage",
      resumeFingerprint: "rf_moka_stage",
      createdAt: "2026-05-22T08:06:45.000Z",
      candidateName: "待入职",
      profile: { title: "Java开发工程师", category: "研发" },
      analysis: {}
    },
    {
      taskId: "legacy-task-2",
      resumeFingerprint: "rf_legacy_duplicate",
      createdAt: "2026-05-22T08:05:00.000Z",
      candidateName: "张三",
      profile: { title: "数据标注师", category: "研发" },
      analysis: {}
    },
    {
      taskId: "legacy-task-1",
      resumeFingerprint: "rf_legacy_duplicate",
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
assert.equal(legacyHistory.length, 1, "Legacy duplicate history should be hidden on read");
assert.equal(legacyHistory[0].id, "legacy-task-2", "Legacy history should use taskId as stable id");
assert.equal(legacyHistory.some((entry) => entry.candidateName === "QS50"), false, "Resume tag names should be hidden from history");
assert.equal(legacyHistory.some((entry) => entry.candidateName === "人才推荐"), false, "Moka tab labels should be hidden from history");
assert.equal(legacyHistory.some((entry) => entry.candidateName === "待入职"), false, "Moka stage labels should be hidden from history");
await deleteAnalysisHistoryEntries([legacyHistory[0].id]);
assert.equal((await listAnalysisHistory()).length, 0, "Batch deletion should remove legacy taskId-only history");
await saveAnalysisHistoryEntry({
  taskId: "task-dedupe-1",
  resumeFingerprint: "rf_same_candidate",
  candidateName: "王五",
  createdAt: "2026-05-22T08:00:00.000Z",
  profile: { title: "Java开发工程师", category: "研发" },
  analysis: {}
});
await saveAnalysisHistoryEntry({
  taskId: "task-dedupe-2",
  resumeFingerprint: "rf_same_candidate",
  candidateName: "王五",
  createdAt: "2026-05-22T08:05:00.000Z",
  profile: { title: "Java开发工程师", category: "研发" },
  analysis: {}
});
const dedupedHistory = await listAnalysisHistory();
assert.equal(dedupedHistory.length, 1, "History should upsert repeated resume fingerprints");
assert.equal(dedupedHistory[0].taskId, "task-dedupe-2", "Latest duplicate history entry should replace older one");
await saveAnalysisHistoryEntry({
  taskId: "task-offer-1",
  candidateName: "赵六",
  createdAt: "2026-05-22T08:10:00.000Z",
  pageKey: "moka:application:795661549",
  pageUrl: "https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436",
  mokaApplicationId: "795661549",
  mokaDetailUrl: "https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436",
  mokaPositionRaw: "Frontend Engineer · Demo",
  mokaPositionTitle: "Frontend Engineer",
  resumeTextLength: 1234,
  resumeImageCount: 3,
  resumeExtractedTextLength: 4567,
  profile: { title: "Java开发工程师", category: "研发" },
  offerApplication: {
    headhunterReport: "第一行\n第二行",
    manualFields: { location: "深圳" },
    generatedFields: { genderAge: "男，23岁" },
    content: "【基础情况】：\n性别年龄：男，23岁"
  },
  analysis: {}
});
const offerHistory = await listAnalysisHistory();
const offerEntry = offerHistory.find((entry) => entry.taskId === "task-offer-1");
assert.equal(offerEntry.offerApplication.manualFields.location, "深圳", "Offer template should persist selected location");
assert.equal(
  offerEntry.offerApplication.content,
  "【基础情况】：\n性别年龄：男，23岁",
  "Offer template content should preserve line breaks"
);
assert.equal(offerEntry.resumeTextLength, 1234, "History should persist page resume text length");
assert.equal(offerEntry.resumeImageCount, 3, "History should persist resume image count");
assert.equal(offerEntry.resumeExtractedTextLength, 4567, "History should persist OCR merged text length");
assert.equal(offerEntry.mokaApplicationId, "795661549", "History should persist Moka application id");
assert.equal(offerEntry.mokaDetailUrl.includes("/candidates/application/795661549/info"), true, "History should persist Moka detail URL");
assert.equal(offerEntry.mokaPositionTitle, "Frontend Engineer", "History should persist Moka header position title");
mockChromeStorage["resumeCopilot.analysisTasks"] = [
  { id: "task-bad-tab", status: "running", candidateName: "人才推荐", createdAt: "2026-05-22T08:00:00.000Z", updatedAt: "2026-05-22T08:00:00.000Z" },
  { id: "task-bad-stage", status: "running", candidateName: "待入职", createdAt: "2026-05-22T08:00:00.000Z", updatedAt: "2026-05-22T08:00:00.000Z" },
  { id: "task-1", status: "running", candidateName: "张三", createdAt: "2026-05-22T08:00:00.000Z", updatedAt: "2026-05-22T08:00:00.000Z" }
];
const readableTasks = await listAnalysisTasks();
assert.equal(readableTasks.length, 1, "Moka tab label tasks should be hidden on read");
assert.equal(readableTasks[0].id, "task-1", "Persisted task status should be readable");
await importResumeCopilotData({
  data: {
    settings: { apiKey: "sk-test", model: "doubao-test" },
    jobProfiles: [{ id: "profile-1", title: "测试岗位", category: "研发", jd: "Java" }],
    analysisHistory: [{ taskId: "task-history-1", candidateName: "李四", profile: { title: "测试岗位", category: "研发" } }],
    analysisTasks: [{ id: "task-2", status: "done", candidateName: "李四" }]
  }
});
const backup = await exportResumeCopilotData();
assert.equal(backup.data.settings.apiKey, "sk-test", "Config backup should include settings");
assert.equal(backup.data.jobProfiles[0].id, "profile-1", "Config backup should include job profiles");
assert.equal(backup.data.analysisHistory[0].taskId, "task-history-1", "Config backup should include history");
delete globalThis.chrome;
assert.equal(shouldRenderPdfPageImages("短文本"), true, "Short PDF text should render images for OCR");
assert.equal(shouldRenderPdfPageImages("候选人".repeat(300)), false, "Long PDF text should skip image OCR");
assert.equal(classifyError("Doubao 返回为空"), ERROR_TYPES.MODEL_EMPTY_RESPONSE);
assert.equal(classifyError("Doubao 请求超时，请稍后重试"), ERROR_TYPES.MODEL_TIMEOUT);
assert.equal(classifyError("任务被浏览器回收中断"), ERROR_TYPES.TASK_INTERRUPTED);
assert.equal(
  createResumeFingerprint({ text: "张三\n工作经历\nA 公司前端开发", imageUrls: [] }),
  createResumeFingerprint({ text: "张三 工作经历 A 公司前端开发", imageUrls: [] }),
  "Resume fingerprints should ignore whitespace-only differences"
);
assert.equal(
  createResumeFingerprint({ pageKey: "moka:application:795452539", text: "第一次采集文本" }),
  createResumeFingerprint({ pageKey: "moka:application:795452539", text: "第二次采集文本略有变化" }),
  "Stable resume page keys should override changing extraction text for fingerprints"
);
assert.notEqual(
  createResumeFingerprint({ pageKey: "moka:application:795452539", text: "第一次采集文本", imageUrls: [] }),
  createResumeFingerprint({ pageKey: "moka:application:795452539", text: "第一次采集文本", imageUrls: ["https://moka-co-oss.mokahr.com/demo/resume.pdf_1.jpg?Signature=a"] }),
  "Moka fingerprints should change when pdf-resume images are captured after a prior text-only run"
);

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
  "extension/shared/pagePolicy.js",
  "extension/shared/errorUtils.js",
  "extension/shared/resumeFingerprint.js",
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
assert.equal(compactText("null"), "", "String placeholder null should be treated as empty text");
assert.deepEqual(ensureArray(["null", null, "有效证据"]), ["有效证据"], "Placeholder null evidence should be removed");
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
assert.equal(
  inferCandidateName(
    "姓名：裴家豪\\n24岁 | +86 18091722183 | 硕士\\n教育经历\\n哈尔滨工程大学"
  ),
  "裴家豪"
);
assert.equal(isCandidateNameRecognized("ccassiduous"), true);
assert.equal(isCandidateNameRecognized("John Smith"), true);
assert.equal(isCandidateNameRecognized("QS50"), false);
assert.equal(isCandidateNameRecognized("QS200"), false);
assert.equal(isCandidateNameRecognized("RAG"), false);
assert.equal(isCandidateNameRecognized("搜索"), false);
assert.equal(isResumeTagLikeCandidateName("搜索"), true);
assert.equal(isCandidateNameRecognized("人才推荐"), false);
assert.equal(isResumeTagLikeCandidateName("人才推荐"), true);
assert.equal(isCandidateNameRecognized("待入职"), false);
assert.equal(isResumeTagLikeCandidateName("待入职"), true);
assert.equal(isCandidateNameRecognized("九坤投资"), false);
assert.equal(isCandidateNameRecognized("双一流"), false);
assert.equal(isCandidateNameRecognized("Senior Frontend Engineer"), false);
assert.equal(isCandidateNameRecognized("Acme Technology Inc"), false);
assert.equal(
  isSupportedResumePage("https://app.mokahr.com/candidates?pipelineId=139436&outerStage=0&stageId=188473"),
  false,
  "Moka candidate list should not auto-trigger resume parsing"
);
assert.equal(
  isSupportedResumePage("https://app.mokahr.com/candidates?pipelineId=139436&outerStage=0&stageId=188473&jobPreference=all&jobStatus%5B0%5D=open&screenStageType=screening"),
  false,
  "Moka candidate list with screening query params should not auto-trigger resume parsing"
);
assert.equal(
  isSupportedResumePage("https://app.mokahr.com/candidates/application/795452539/info?pipelineId=139436&outerStage=0"),
  true,
  "Moka candidate detail should auto-trigger resume parsing"
);
assert.equal(
  isSupportedResumePage("https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436&outerStage=0&stageId=188473&jobPreference=all&jobStatus%5B0%5D=open&screenStageType=screening"),
  true,
  "Moka candidate application detail with screening query params should auto-trigger resume parsing"
);
assert.equal(
  getResumePageKey("https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436&outerStage=0&stageId=188473&jobPreference=all&jobStatus%5B0%5D=open&screenStageType=screening"),
  "moka:application:795661549",
  "Moka candidate application detail should derive page key from application id"
);
assert.equal(
  getMokaApplicationId("https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436"),
  "795661549",
  "Moka candidate application detail should expose the raw application id"
);
assert.equal(
  getMokaDetailUrl("https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436"),
  "https://app.mokahr.com/candidates/application/795661549/info?pipelineId=139436",
  "Moka candidate detail URL should be persisted exactly"
);
assert.equal(
  isSupportedResumePage("https://app.mokahr.com/candidates/application/795452539/attachments/resume?pipelineId=139436&outerStage=0"),
  true,
  "Moka candidate detail sub-routes should auto-trigger resume parsing"
);
assert.equal(
  getResumePageKey("https://app.mokahr.com/candidates/application/795452539/info?pipelineId=139436&outerStage=0"),
  "moka:application:795452539",
  "Moka candidate detail should provide a stable resume page key"
);
assert.equal(
  isSupportedResumePage("https://www.zhipin.com/web/geek/recommend"),
  true,
  "BOSS pages keep broad support because resume details are modal-based"
);

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

const nullEvidenceAnalysis = normalizeAnalysis(
  {
    scoreBreakdown: {
      internalRequirements: { score: 0, maxScore: 30, reason: "null", evidence: ["null", null, "明确证据"] }
    }
  },
  { id: "profile-2", title: "软件开发工程师" }
);
assert.equal(nullEvidenceAnalysis.scoreBreakdown.internalRequirements.reason, "", "Placeholder null reason should be removed");
assert.deepEqual(nullEvidenceAnalysis.scoreBreakdown.internalRequirements.evidence, ["明确证据"], "Placeholder null evidence should be removed");

const javascriptFiles = requiredFiles.filter((file) => /\.(mjs|js)$/.test(file));
for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
}

console.log("Extension validation passed.");
