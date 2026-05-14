import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compactText,
  ensureArray,
  formatJson,
  parseJsonLike
} from "../extension/shared/jsonUtils.js";

const root = process.cwd();
const manifestPath = join(root, "extension", "manifest.json");

assert.equal(existsSync(manifestPath), true, "manifest.json should exist");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.manifest_version, 3, "manifest should use MV3");
assert.equal(manifest.permissions.includes("storage"), true, "storage permission is required");
assert.equal(manifest.permissions.includes("sidePanel"), true, "sidePanel permission is required");
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
  "extension/sidepanel/sidepanel.html",
  "extension/sidepanel/sidepanel.css",
  "extension/sidepanel/sidepanel.js",
  "extension/content/bossResumeExtractor.js",
  "extension/shared/storage.js",
  "extension/shared/deepseekClient.js",
  "extension/shared/prompts.js",
  "extension/shared/jsonUtils.js",
  "extension/shared/pdfTextExtractor.js",
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
assert.deepEqual(ensureArray([{ project: "Agent eval", reason: "Strong evidence\\nwith detail" }]), [
  { project: "Agent eval", reason: "Strong evidence with detail" }
]);

const javascriptFiles = requiredFiles.filter((file) => /\.(mjs|js)$/.test(file));
for (const file of javascriptFiles) {
  execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
}

console.log("Extension validation passed.");
