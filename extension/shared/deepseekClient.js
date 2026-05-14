import { parseJsonLike, normalizeAnalysis, normalizeJobProfile } from "./jsonUtils.js";
import { buildCandidateAnalysisMessages, buildJobProfileMessages } from "./prompts.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export async function createJobProfileFromJD({ apiKey, model, jdText }) {
  const payload = await callDeepSeek({
    apiKey,
    model,
    messages: buildJobProfileMessages(jdText)
  });
  return normalizeJobProfile(parseJsonLike(payload), jdText);
}

export async function analyzeCandidate({ apiKey, model, jobProfile, resumeText }) {
  const payload = await callDeepSeek({
    apiKey,
    model,
    messages: buildCandidateAnalysisMessages(jobProfile, resumeText)
  });
  return normalizeAnalysis(parseJsonLike(payload), jobProfile);
}

async function callDeepSeek({ apiKey, model, messages }) {
  if (!apiKey) {
    throw new Error("请先在 Options 页面配置 DeepSeek API Key");
  }

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek 请求失败：${response.status} ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek 返回为空");
  }
  return content;
}
