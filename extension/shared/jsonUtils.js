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
    return parseJsonWithControlCharRepair(extracted);
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
  const matchScore = scoreBreakdown ? scoreTotal : Number.isFinite(rawScore) ? rawScore : 0;
  const recommendation = analysis?.matchedRole?.recommendation || inferRecommendation(matchScore);
  const experienceAnalysis = normalizeExperienceAnalysis(analysis?.experienceAnalysis, scoreBreakdown, selectedProfile);
  const elimination = normalizeElimination(analysis?.elimination, scoreBreakdown, matchScore, recommendation);
  const interviewQuestions = ensureArray(analysis?.interviewQuestions);
  const copyableConclusion =
    compactText(analysis?.copyableConclusion) ||
    buildCopyableConclusion({
      candidateName: analysis?.candidateName,
      profile: selectedProfile,
      matchScore,
      recommendation,
      scoreBreakdown,
      elimination
    });

  return {
    candidateName: compactText(analysis?.candidateName || ""),
    matchedRole: {
      roleId: analysis?.matchedRole?.roleId || selectedProfile.id,
      roleName: analysis?.matchedRole?.roleName || selectedProfile.title,
      matchScore,
      recommendation
    },
    scoreBreakdown,
    thresholdChecks: normalizeThresholdChecks(analysis?.thresholdChecks),
    experienceAnalysis,
    objectiveAnalysis: {
      education: analysis?.objectiveAnalysis?.education || {},
      ageAndExperience: analysis?.objectiveAnalysis?.ageAndExperience || {},
      employmentStatus: analysis?.objectiveAnalysis?.employmentStatus || {}
    },
    elimination,
    interviewQuestions: interviewQuestions.length ? interviewQuestions : buildInterviewQuestions(scoreBreakdown, selectedProfile),
    copyableConclusion
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
          evidence: ensureArray(item.evidence),
          confidence: normalizeConfidence(item.confidence)
        }
      ];
    })
  );
}

function normalizeConfidence(value) {
  const text = compactText(value).toLowerCase();
  return ["high", "medium", "low"].includes(text) ? text : "";
}

function normalizeExperienceAnalysis(value, scoreBreakdown, selectedProfile) {
  const source = value && typeof value === "object" ? value : {};
  const matchedProjects = ensureArray(source.matchedProjects);
  const mismatchedProjects = ensureArray(source.mismatchedProjects);
  const overclaimRisks = ensureArray(source.overclaimRisks);
  const highValueSignals = ensureArray(source.highValueSignals);
  const weakDimensions = getScoreItems(scoreBreakdown).filter((item) => item.score <= Math.max(1, item.maxScore * 0.35));
  const strongDimensions = getScoreItems(scoreBreakdown).filter((item) => item.score >= item.maxScore * 0.7);

  return {
    oneLineProfile:
      compactText(source.oneLineProfile) ||
      buildOneLineProfile(scoreBreakdown, selectedProfile),
    matchedProjects: matchedProjects.length
      ? matchedProjects
      : strongDimensions.map((item) => ({ project: item.label, reason: item.reason, valueLevel: "medium" })),
    mismatchedProjects: mismatchedProjects.length
      ? mismatchedProjects
      : weakDimensions.map((item) => ({ project: item.label, reason: item.reason })),
    overclaimRisks,
    highValueSignals
  };
}

function normalizeElimination(value, scoreBreakdown, matchScore, recommendation) {
  const source = value && typeof value === "object" ? value : {};
  const reasons = ensureArray(source.reasons);
  const shouldReject = Boolean(source.shouldReject) || /淘汰|不推荐|拒绝/i.test(String(recommendation || "")) || matchScore < 40;
  return {
    shouldReject,
    reasons: reasons.length ? reasons : shouldReject ? buildEliminationReasons(scoreBreakdown) : []
  };
}

function getScoreItems(scoreBreakdown) {
  if (!scoreBreakdown || typeof scoreBreakdown !== "object") return [];
  return SCORE_DIMENSIONS.map((dimension) => {
    const item = scoreBreakdown[dimension.key] || {};
    return {
      key: dimension.key,
      label: compactText(item.label || dimension.label),
      score: Number(item.score ?? 0),
      maxScore: Number(item.maxScore ?? dimension.maxScore),
      reason: compactText(item.reason || "")
    };
  });
}

function buildOneLineProfile(scoreBreakdown, selectedProfile) {
  const weak = getScoreItems(scoreBreakdown)
    .filter((item) => item.reason)
    .sort((a, b) => a.score / a.maxScore - b.score / b.maxScore)[0];
  if (weak) return `候选人与${selectedProfile.title || "当前岗位"}匹配度偏低，主要问题是${weak.reason}`;
  return `候选人与${selectedProfile.title || "当前岗位"}的匹配信息不足，需要人工复核。`;
}

function buildEliminationReasons(scoreBreakdown) {
  return getScoreItems(scoreBreakdown)
    .filter((item) => item.reason && item.score <= Math.max(1, item.maxScore * 0.35))
    .slice(0, 3)
    .map((item) => `${item.label}：${item.reason}`);
}

function buildInterviewQuestions(scoreBreakdown, selectedProfile) {
  const questions = getScoreItems(scoreBreakdown)
    .filter((item) => item.score < item.maxScore && item.reason)
    .slice(0, 3)
    .map((item) => `请候选人补充说明${item.label}相关经历：${item.reason}`);
  return questions.length ? questions : [`请围绕${selectedProfile.title || "当前岗位"}确认候选人的实际项目经验和可投入时间。`];
}

function buildCopyableConclusion({ candidateName, profile, matchScore, recommendation, scoreBreakdown, elimination }) {
  const reasons = elimination.reasons.length
    ? elimination.reasons
    : getScoreItems(scoreBreakdown).filter((item) => item.reason).slice(0, 2).map((item) => item.reason);
  return compactText(
    `${compactText(candidateName) || "候选人"}匹配${profile.title || "当前岗位"}得分${matchScore}，结论：${recommendation}。${reasons.slice(0, 2).join("；")}`
  );
}

function inferRecommendation(score) {
  if (score >= 80) return "建议面试";
  if (score >= 60) return "谨慎面试";
  if (score >= 40) return "需要人工复核";
  return "建议淘汰";
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

function parseJsonWithControlCharRepair(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!/control character/i.test(error?.message || "")) throw error;
    return JSON.parse(escapeControlCharsInJsonStrings(text));
  }
}

function escapeControlCharsInJsonStrings(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const code = char.charCodeAt(0);

    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }

    if (code <= 0x1f) {
      output += escapeJsonControlChar(char, code);
      continue;
    }

    output += char;
  }

  return output;
}

function escapeJsonControlChar(char, code) {
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  if (char === "\t") return "\\t";
  return `\\u${code.toString(16).padStart(4, "0")}`;
}
