export function parseJsonLike(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("JSON 内容为空");
  }

  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const extracted = extractFirstJsonObject(unfenced);
    if (!extracted) {
      throw new Error("未找到有效 JSON 对象");
    }
    return JSON.parse(extracted);
  }
}

export function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

export function ensureArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeArrayItem(item)).filter(Boolean);
  if (value == null || value === "") return [];
  return [normalizeArrayItem(value)].filter(Boolean);
}

export function normalizeJobProfile(profile, fallbackJd = "") {
  const now = new Date().toISOString();
  return {
    id: profile.id || createId(),
    title: compactText(profile.title || "未命名岗位"),
    jd: compactText(profile.jd || fallbackJd || ""),
    mustHave: ensureArray(profile.mustHave),
    niceToHave: ensureArray(profile.niceToHave),
    riskFlags: ensureArray(profile.riskFlags),
    interviewFocus: ensureArray(profile.interviewFocus),
    updatedAt: profile.updatedAt || now
  };
}

export function normalizeAnalysis(analysis, selectedProfile) {
  return {
    matchedRole: {
      roleId: analysis?.matchedRole?.roleId || selectedProfile.id,
      roleName: analysis?.matchedRole?.roleName || selectedProfile.title,
      matchScore: Number(analysis?.matchedRole?.matchScore ?? 0),
      recommendation: analysis?.matchedRole?.recommendation || "需要人工复核"
    },
    experienceAnalysis: {
      oneLineProfile: analysis?.experienceAnalysis?.oneLineProfile || "",
      matchedProjects: ensureArray(analysis?.experienceAnalysis?.matchedProjects),
      mismatchedProjects: ensureArray(analysis?.experienceAnalysis?.mismatchedProjects),
      overclaimRisks: ensureArray(analysis?.experienceAnalysis?.overclaimRisks),
      highValueSignals: ensureArray(analysis?.experienceAnalysis?.highValueSignals)
    },
    objectiveAnalysis: {
      education: analysis?.objectiveAnalysis?.education || {},
      ageAndExperience: analysis?.objectiveAnalysis?.ageAndExperience || {},
      employmentStatus: analysis?.objectiveAnalysis?.employmentStatus || {}
    },
    elimination: {
      shouldReject: Boolean(analysis?.elimination?.shouldReject),
      reasons: ensureArray(analysis?.elimination?.reasons)
    },
    interviewQuestions: ensureArray(analysis?.interviewQuestions),
    copyableConclusion: analysis?.copyableConclusion || ""
  };
}

export function createId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function compactText(value) {
  return String(value || "")
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeArrayItem(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => normalizeArrayItem(item)).filter(Boolean);
  if (typeof value === "object") return compactObject(value);
  return compactText(value);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [
        key,
        typeof item === "string"
          ? compactText(item)
          : Array.isArray(item)
            ? item.map((child) => normalizeArrayItem(child)).filter(Boolean)
            : item && typeof item === "object"
              ? compactObject(item)
              : item
      ])
      .filter(([, item]) => item !== "" && item != null)
  );
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return "";
}
