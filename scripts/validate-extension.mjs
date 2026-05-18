import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compactText,
  ensureArray,
  formatJson,
  normalizeJobCategory,
  parseJsonLike
} from "../extension/shared/jsonUtils.js";
import {
  inferCandidateName,
  isCandidateNameRecognized
} from "../extension/shared/candidateUtils.js";

const root = process.cwd();
const manifestPath = join(root, "extension", "manifest.json");

assert.equal(existsSync(manifestPath), true, "manifest.json should exist");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3, "manifest should use MV3");
assert.equal(manifest.permissions.includes("storage"), true, "storage permission is required");
assert.equal(manifest.permissions.includes("sidePanel"), true, "sidePanel permission is required");
assert.equal(manifest.permissions.includes("tabs"), true, "tabs permission is required");
assert.equal(
  manifest.host_permissions.includes("https://api.deepseek.com/*"),
  true,
  "DeepSeek host permission is required"
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

const javascriptFiles = requiredFiles.filter((file) => /\.(mjs|js)$/.test(file));
for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
}

console.log("Extension validation passed.");
