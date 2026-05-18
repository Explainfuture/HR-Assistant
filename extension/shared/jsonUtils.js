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

export const JOB_CATEGORIES = ["研发", "产品", "市场", "销售", "职能"];

export const SCORE_DIMENSIONS = [
  { key: "internalRequirements", label: "内部定制需求", maxScore: 30 },
  { key: "coreExperience", label: "核心经历", maxScore: 30 },
  { key: "keySkills", label: "关键技能", maxScore: 15 },
  { key: "stability", label: "稳定性", maxScore: 10 },
  { key: "businessUnderstanding", label: "行业/业务理解", maxScore: 15 }
];

const CATEGORY_KEYWORDS = {
  研发: [
    "研发",
    "开发",
    "工程师",
    "架构",
    "前端",
    "后端",
    "全栈",
    "算法",
    "数据",
    "测试",
    "运维",
    "ios",
    "android",
    "java",
    "python",
    "go",
    "c++"
  ],
  产品: ["产品", "pm", "需求", "用户体验", "交互", "增长产品"],
  市场: ["市场", "运营", "pr", "公关", "品牌", "投放", "内容", "新媒体", "增长"],
  销售: ["销售", "商务", "解决方案", "交付", "客户成功", "售前", "渠道"],
  职能: ["职能", "采购", "hr", "人力", "招聘", "财务", "法务", "行政", "组织发展"]
};

export function normalizeJobCategory(category, title = "", jd = "") {
  const explicit = compactText(category);
  if (JOB_CATEGORIES.includes(explicit)) return explicit;

  const haystack = `${title} ${jd}`.toLowerCase();
  for (const [candidate, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return candidate;
    }
  }

  return "职能";
}

export function ensureArray(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeArrayItem(item)).filter(Boolean);
  if (value == null || value === "") return [];
  return [normalizeArrayItem(value)].filter(Boolean);
}

export function normalizeJobProfile(profile, fallbackJd = "") {
  const now = new Date().toISOString();
  const title = compactText(profile.title || "未命名岗位");
  const jd = compactText(profile.jd || fallbackJd || "");

  return {
    id: profile.id || createId(),
    title,
    category: normalizeJobCategory(profile.category, title, jd),
    jd,
    internalRequirements: compactText(profile.internalRequirements || ""),
    mustHave: ensureArray(profile.mustHave),
    niceToHave: ensureArray(profile.niceToHave),
    riskFlags: ensureArray(profile.riskFlags),
    interviewFocus: ensureArray(profile.interviewFocus),
    updatedAt: profile.updatedAt || now
  };
}

export function normalizeAnalysis(analysis, selectedProfile) {
  const scoreBreakdown = normalizeScoreBreakdown(analysis?.scoreBreakdown);
  const scoreTotal = scoreBreakdown
    ? Object.values(scoreBreakdown).reduce((sum, item) => sum + item.score, 0)
    : 0;
  const rawScore = Number(analysis?.matchedRole?.matchScore);

  return {
    candidateName: compactText(analysis?.candidateName || ""),
    matchedRole: {
      roleId: analysis?.matchedRole?.roleId || selectedProfile.id,
      roleName: analysis?.matchedRole?.roleName || selectedProfile.title,
      matchScore: scoreBreakdown ? scoreTotal : Number.isFinite(rawScore) ? rawScore : 0,
      recommendation: analysis?.matchedRole?.recommendation || "需要人工复核"
    },
    scoreBreakdown,
    thresholdChecks: normalizeThresholdChecks(analysis?.thresholdChecks),
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

function normalizeScoreBreakdown(value) {
  if (!value || typeof value !== "object") return null;
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    SCORE_DIMENSIONS.map((dimension) => {
      const item = source[dimension.key] || {};
      const score = clampScore(Number(item.score ?? 0), dimension.maxScore);
      const maxScore = Number(item.maxScore ?? dimension.maxScore);
      return [
        dimension.key,
        {
          label: compactText(item.label || dimension.label),
          score,
          maxScore: Number.isFinite(maxScore) && maxScore > 0 ? maxScore : dimension.maxScore,
          reason: compactText(item.reason || ""),
          evidence: ensureArray(item.evidence)
        }
      ];
    })
  );
}

function normalizeThresholdChecks(value) {
  if (!value || typeof value !== "object") return null;
  const source = value && typeof value === "object" ? value : {};
  return {
    age: normalizeThresholdCheck(source.age, "年龄门槛"),
    education: normalizeThresholdCheck(source.education, "学历门槛")
  };
}

function normalizeThresholdCheck(value, label) {
  const source = value && typeof value === "object" ? value : {};
  const status = ["satisfied", "unsatisfied", "unknown"].includes(source.status)
    ? source.status
    : "unknown";
  return {
    label: compactText(source.label || label),
    status,
    summary: compactText(source.summary || ""),
    reason: compactText(source.reason || ""),
    followUp: compactText(source.followUp || "")
  };
}

function clampScore(value, maxScore) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), maxScore));
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
