import { parseJsonLike, normalizeAnalysis, normalizeJobProfile } from "./jsonUtils.js";
import {
  buildCandidateAnalysisMessages,
  buildJobProfileMessages,
  buildOfferApplicationMessages
} from "./prompts.js";

const DOUBAO_RESPONSES_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const DEFAULT_REASONING_EFFORT = "high";
const OCR_REASONING_EFFORT = "low";
const DEFAULT_RESPONSE_TIMEOUT_MS = 90000;
const IMAGE_RESPONSE_TIMEOUT_MS = 75000;
const OCR_PAGE_CONCURRENCY = 2;

export async function createJobProfileFromJD({ apiKey, model, jdText, internalRequirements = "" }) {
  const payload = await callDoubaoResponses({
    apiKey,
    model,
    prompt: buildJobProfileMessages(jdText, internalRequirements).map((m) => `${m.role}: ${m.content}`).join("\n\n")
  });
  return normalizeJobProfile(
    {
      ...parseJsonLike(payload),
      internalRequirements
    },
    jdText
  );
}

export async function analyzeCandidate({ apiKey, model, jobProfile, resumeText, resumeImages = [], onProgress }) {
  if (resumeImages.length) {
    onProgress?.({ finished: 0, total: 1, stage: "ocr", ocrFinished: 0, ocrTotal: resumeImages.length });
  }
  const resumePayload = resumeImages.length
    ? await recognizeResumeFromImages({
        apiKey,
        model,
        resumeText,
        resumeImages,
        onProgress: (ocrProgress) => onProgress?.({ finished: 0, total: 1, stage: "ocr", ...ocrProgress })
      })
    : { rawText: resumeText };
  onProgress?.({ finished: 0, total: 1, stage: "matching" });
  const payload = await callDoubaoResponses({
    apiKey,
    model,
    prompt: buildCandidateAnalysisMessages(jobProfile, resumePayload.rawText).map((m) => `${m.role}: ${m.content}`).join("\n\n")
  });
  return {
    ...normalizeAnalysis(parseJsonLike(payload), jobProfile),
    resumeExtractedText: resumePayload.rawText
  };
}

export async function analyzeCandidateAgainstProfiles({ apiKey, model, jobProfiles, resumeText, resumeImages = [], concurrency = 3, onProgress }) {
  const profiles = Array.isArray(jobProfiles) ? jobProfiles : [];
  if (!profiles.length) throw new Error("没有可用于自动匹配的岗位知识库");

  if (resumeImages.length) {
    onProgress?.({ finished: 0, total: profiles.length, stage: "ocr", ocrFinished: 0, ocrTotal: resumeImages.length });
  }
  const sharedResumePayload = resumeImages.length
    ? await recognizeResumeFromImages({
        apiKey,
        model,
        resumeText,
        resumeImages,
        onProgress: (ocrProgress) => onProgress?.({ finished: 0, total: profiles.length, stage: "ocr", ...ocrProgress })
      })
    : { rawText: resumeText };
  onProgress?.({ finished: 0, total: profiles.length, stage: "matching" });

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, profiles.length));
  const results = new Array(profiles.length);
  let nextIndex = 0;
  let finished = 0;

  async function worker() {
    while (nextIndex < profiles.length) {
      const index = nextIndex;
      nextIndex += 1;
      const profile = profiles[index];
      try {
        results[index] = { profile, analysis: await analyzeCandidate({ apiKey, model, jobProfile: profile, resumeText: sharedResumePayload.rawText }) };
      } catch (error) {
        results[index] = { profile, error: error.message || String(error) };
      } finally {
        finished += 1;
        onProgress?.({ finished, total: profiles.length, profile, stage: "matching" });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function generateOfferApplicationFields({ apiKey, model, candidateName, profile, analysis, resumeText = "", headhunterReport }) {
  const payload = await callDoubaoResponses({
    apiKey,
    model,
    prompt: buildOfferApplicationMessages({ candidateName, profile, analysis, resumeText, headhunterReport })
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n")
  });
  return normalizeOfferApplicationFields(parseJsonLike(payload));
}

function normalizeOfferApplicationFields(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    genderAge: compactField(source.genderAge),
    education: compactField(source.education),
    recentCompanyBackground: compactField(source.recentCompanyBackground),
    positioning: compactField(source.positioning),
    highlights: compactField(source.highlights)
  };
}

function compactField(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function recognizeResumeFromImages({ apiKey, model, resumeText = "", resumeImages, onProgress }) {
  const images = Array.isArray(resumeImages) ? resumeImages.filter(Boolean) : [];
  const pageResults = new Array(images.length);
  let nextIndex = 0;
  let finished = 0;

  async function worker() {
    while (nextIndex < images.length) {
      const index = nextIndex;
      nextIndex += 1;
      pageResults[index] = await recognizeResumeImagePage({
        apiKey,
        model,
        imageUrl: images[index],
        pageIndex: index
      });
      finished += 1;
      onProgress?.({ ocrFinished: finished, ocrTotal: images.length });
    }
  }

  const workerCount = Math.max(1, Math.min(OCR_PAGE_CONCURRENCY, images.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const parsed = {
    raw_text: pageResults
      .map((page, index) => [`第 ${index + 1} 页`, page?.rawText || ""].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n"),
    sections: pageResults.flatMap((page) => page?.sections || []),
    blocks: pageResults.map((page, index) => ({ index: index + 1, text: page?.rawText || "" }))
  };
  const rawText = mergeRecognizedResumeText(resumeText, parsed);
  if (rawText.length < 40) throw new Error("图片简历识别结果过短，请确认页面存在可访问的简历图片");
  return { rawText };
}

async function recognizeResumeImagePage({ apiKey, model, imageUrl, pageIndex }) {
  const prompt = `你是简历图片OCR。请只转写这1页简历的文字，不要评价、不总结、不补充。保持原有顺序，项目经历、工作经历、教育经历、技能要完整。\n输出严格JSON：{"raw_text":"","sections":[{"title":"","content":""}]}`;
  const payload = await callDoubaoResponses({
    apiKey,
    model,
    prompt,
    imageUrls: [imageUrl],
    timeoutMs: IMAGE_RESPONSE_TIMEOUT_MS,
    reasoningEffort: OCR_REASONING_EFFORT
  });
  const parsed = parseOcrPayload(payload);
  const rawText = mergeRecognizedResumeText("", parsed);
  return {
    pageIndex,
    rawText,
    sections: Array.isArray(parsed?.sections) ? parsed.sections : []
  };
}

function parseOcrPayload(payload) {
  try {
    return parseJsonLike(payload);
  } catch {
    return { raw_text: String(payload || "").trim() };
  }
}

function mergeRecognizedResumeText(sourceText, parsed) {
  const parts = [sourceText];

  const rawText = String(parsed?.raw_text || "").trim();
  if (rawText) parts.push(rawText);

  for (const section of Array.isArray(parsed?.sections) ? parsed.sections : []) {
    const title = compactField(section?.title);
    const content = compactField(section?.content || section?.text);
    if (title || content) parts.push([title, content].filter(Boolean).join("\n"));
  }

  for (const block of Array.isArray(parsed?.blocks) ? parsed.blocks : []) {
    const text = compactField(block?.text || block?.content);
    if (text) parts.push(text);
  }

  return dedupeResumeLines(parts.join("\n"));
}

function dedupeResumeLines(text) {
  const seen = new Set();
  const lines = [];
  for (const line of String(text || "").split(/\r?\n+/)) {
    const normalized = compactField(line);
    if (!normalized) continue;
    const key = normalized.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(normalized);
  }
  return lines.join("\n").slice(0, 60000);
}

async function callDoubaoResponses({
  apiKey,
  model,
  prompt,
  imageUrls = [],
  timeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  reasoningEffort = DEFAULT_REASONING_EFFORT
}) {
  if (!apiKey) throw new Error("请先在 Options 页面配置 Doubao API Key");

  const inputContent = [{ type: "input_text", text: prompt }];
  for (const url of imageUrls) {
    inputContent.push({ type: "input_image", image_url: url });
  }

  const response = await fetchWithTimeout(
    DOUBAO_RESPONSES_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        reasoning: { effort: reasoningEffort },
        input: [{ role: "user", content: inputContent }]
      })
    },
    timeoutMs
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Doubao 请求失败：${response.status} ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = extractDoubaoResponseText(data);
  if (!content) {
    const reason = data?.incomplete_details?.reason || data?.error?.message || "";
    throw new Error(reason ? `Doubao 返回为空：${reason}` : "Doubao 返回为空");
  }
  return content;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_RESPONSE_TIMEOUT_MS));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Doubao 请求超时，请稍后重试或减少简历图片数量`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function extractDoubaoResponseText(data) {
  const directOutputText = getNonEmptyText(data?.output_text);
  if (directOutputText) return directOutputText;

  const choiceText = extractChoiceText(data?.choices);
  if (choiceText) return choiceText;

  for (const outputItem of Array.isArray(data?.output) ? data.output : []) {
    const text = extractContentText(outputItem);
    if (text) return text;
  }

  return "";
}

function extractChoiceText(choices) {
  for (const choice of Array.isArray(choices) ? choices : []) {
    const messageContent = choice?.message?.content;
    if (typeof messageContent === "string") {
      const text = getNonEmptyText(messageContent);
      if (text) return text;
    }

    const text = extractContentText(messageContent);
    if (text) return text;
  }

  return "";
}

function extractContentText(value) {
  if (!value) return "";

  if (typeof value === "string") {
    return getNonEmptyText(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractContentText(item);
      if (text) return text;
    }
    return "";
  }

  if (typeof value !== "object") return "";

  if (["output_text", "text"].includes(value.type)) {
    const typedText = getNonEmptyText(value.text);
    if (typedText) return typedText;
  }

  const contentText = extractContentText(value.content);
  if (contentText) return contentText;

  return "";
}

function getNonEmptyText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "";
}
