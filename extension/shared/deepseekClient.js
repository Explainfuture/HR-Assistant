import { parseJsonLike, normalizeAnalysis, normalizeJobProfile } from "./jsonUtils.js";
import { buildCandidateAnalysisMessages, buildJobProfileMessages } from "./prompts.js";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

export async function createJobProfileFromJD({ apiKey, model, jdText, internalRequirements = "" }) {
  const payload = await callDeepSeek({
    apiKey,
    model,
    messages: buildJobProfileMessages(jdText, internalRequirements)
  });
  return normalizeJobProfile(
    {
      ...parseJsonLike(payload),
      internalRequirements
    },
    jdText
  );
}

export async function analyzeCandidate({ apiKey, model, jobProfile, resumeText }) {
  const payload = await callDeepSeek({
    apiKey,
    model,
    messages: buildCandidateAnalysisMessages(jobProfile, resumeText)
  });
  return normalizeAnalysis(parseJsonLike(payload), jobProfile);
}

export async function analyzeCandidateAgainstProfiles({
  apiKey,
  model,
  jobProfiles,
  resumeText,
  concurrency = 3,
  onProgress
}) {
  const profiles = Array.isArray(jobProfiles) ? jobProfiles : [];
  if (!profiles.length) {
    throw new Error("没有可用于自动匹配的岗位知识库");
  }

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
        results[index] = {
          profile,
          analysis: await analyzeCandidate({ apiKey, model, jobProfile: profile, resumeText })
        };
      } catch (error) {
        results[index] = {
          profile,
          error: error.message || String(error)
        };
      } finally {
        finished += 1;
        onProgress?.({ finished, total: profiles.length, profile });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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
