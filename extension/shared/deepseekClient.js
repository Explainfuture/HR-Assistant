import { parseJsonLike, normalizeAnalysis, normalizeJobProfile } from "./jsonUtils.js";
import { buildCandidateAnalysisMessages, buildJobProfileMessages } from "./prompts.js";

const DOUBAO_RESPONSES_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/responses";
const DEFAULT_REASONING_EFFORT = "high";

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

export async function analyzeCandidate({ apiKey, model, jobProfile, resumeText, resumeImages = [] }) {
  const resumePayload = resumeImages.length
    ? await recognizeResumeFromImages({ apiKey, model, resumeImages })
    : { rawText: resumeText };
  const payload = await callDoubaoResponses({
    apiKey,
    model,
    prompt: buildCandidateAnalysisMessages(jobProfile, resumePayload.rawText).map((m) => `${m.role}: ${m.content}`).join("\n\n")
  });
  return normalizeAnalysis(parseJsonLike(payload), jobProfile);
}

export async function analyzeCandidateAgainstProfiles({ apiKey, model, jobProfiles, resumeText, resumeImages = [], concurrency = 3, onProgress }) {
  const profiles = Array.isArray(jobProfiles) ? jobProfiles : [];
  if (!profiles.length) throw new Error("没有可用于自动匹配的岗位知识库");

  const sharedResumePayload = resumeImages.length
    ? await recognizeResumeFromImages({ apiKey, model, resumeImages })
    : { rawText: resumeText };

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
        onProgress?.({ finished, total: profiles.length, profile });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function recognizeResumeFromImages({ apiKey, model, resumeImages }) {
  const prompt = `你是简历OCR与结构化助手。请识别图片简历，输出严格JSON：\n{\n  "resume_json": {"name":"","phone":"","email":"","education":[],"work_experience":[],"skills":[],"projects":[],"languages":[],"certifications":[]},\n  "sections": [{"title":"","content":""}],\n  "blocks": [{"index":1,"text":""}],\n  "raw_text":""\n}`;
  const payload = await callDoubaoResponses({ apiKey, model, prompt, imageUrls: resumeImages });
  const parsed = parseJsonLike(payload);
  const rawText = String(parsed?.raw_text || "").trim();
  if (rawText.length < 40) throw new Error("图片简历识别结果过短，请确认页面存在可访问的简历图片");
  return { rawText };
}

async function callDoubaoResponses({ apiKey, model, prompt, imageUrls = [] }) {
  if (!apiKey) throw new Error("请先在 Options 页面配置 Doubao API Key");

  const inputContent = [{ type: "input_text", text: prompt }];
  for (const url of imageUrls.slice(0, 8)) {
    inputContent.push({ type: "input_image", image_url: url });
  }

  const response = await fetch(DOUBAO_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      reasoning: { effort: DEFAULT_REASONING_EFFORT },
      input: [{ role: "user", content: inputContent }]
    })
  });

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
