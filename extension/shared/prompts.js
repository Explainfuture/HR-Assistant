export function buildJobProfileMessages(jdText, internalRequirements = "") {
  const internalBlock = internalRequirements
    ? `\n内部定制需求（优先级高于 JD）：\n${internalRequirements}\n`
    : "\n内部定制需求：无\n";

  return [
    {
      role: "system",
      content:
        "你是招聘岗位知识库结构化助手。只输出严格 JSON，不要输出 markdown、解释或代码块。"
    },
    {
      role: "user",
      content: `请把下面 JD 结构化为岗位知识库 JSON。

输出字段必须为：
{
  "title": "岗位名",
  "category": "研发/产品/市场/销售/职能",
  "jd": "原始JD全文",
  "internalRequirements": "内部定制需求全文；没有则为空字符串",
  "mustHave": ["硬性要求"],
  "niceToHave": ["加分项"],
  "riskFlags": ["筛选时需要警惕的风险点"],
  "interviewFocus": ["面试重点追问方向"]
}

要求：
- title 从 JD 中提取；如果无法判断，使用最接近的岗位名。
- category 必须从“研发、产品、市场、销售、职能”中选择一个；市场包含运营、PR、品牌、投放等；销售包含销售、解决方案、交付经理等；职能包含采购、HR 等。
- mustHave 只放真正影响筛选的硬性要求。
- niceToHave 放增强匹配但不是必须的条件。
- riskFlags 要能辅助 HR 判断候选人是否在包装经历。
- interviewFocus 要可用于面试追问。
- 保留 jd 原文。
- internalRequirements 必须保留内部定制需求原文；如果它与 JD 冲突，以内部定制需求为准。

JD：
${jdText}
${internalBlock}`
    }
  ];
}

export function buildCandidateAnalysisMessages(jobProfile, resumeText) {
  return [
    {
      role: "system",
      content:
        "你是严谨的招聘简历分析助手。只输出严格 JSON，不要输出 markdown、解释或代码块。不要评价薪资和职级。"
    },
    {
      role: "user",
      content: `请基于岗位知识库和候选人简历文本，输出候选人与当前手动选择岗位的匹配分析。

岗位知识库 JSON：
${JSON.stringify(jobProfile, null, 2)}

候选人简历文本：
${resumeText}

输出必须严格符合下面 JSON 结构：
{
  "candidateName": "候选人真实姓名；如果简历未明确体现，返回空字符串",
  "matchedRole": {
    "roleId": "${jobProfile.id}",
    "roleName": "${jobProfile.title}",
    "matchScore": 0,
    "recommendation": "建议面试/谨慎面试/建议淘汰/需要人工复核"
  },
  "scoreBreakdown": {
    "internalRequirements": {
      "label": "内部定制需求",
      "score": 0,
      "maxScore": 30,
      "reason": "结合内部定制需求说明得分原因",
      "evidence": ["简历中的证据"],
      "confidence": "high/medium/low"
    },
    "coreExperience": {
      "label": "核心经历",
      "score": 0,
      "maxScore": 30,
      "reason": "说明核心岗位经历的匹配程度",
      "evidence": ["简历中的证据"],
      "confidence": "high/medium/low"
    },
    "keySkills": {
      "label": "关键技能",
      "score": 0,
      "maxScore": 15,
      "reason": "说明关键技能命中情况",
      "evidence": ["简历中的证据"],
      "confidence": "high/medium/low"
    },
    "stability": {
      "label": "稳定性",
      "score": 0,
      "maxScore": 10,
      "reason": "说明履历稳定性、空窗或跳槽风险",
      "evidence": ["简历中的证据"],
      "confidence": "high/medium/low"
    },
    "businessUnderstanding": {
      "label": "行业/业务理解",
      "score": 0,
      "maxScore": 15,
      "reason": "说明行业、业务、场景理解的匹配程度",
      "evidence": ["简历中的证据"],
      "confidence": "high/medium/low"
    }
  },
  "thresholdChecks": {
    "age": {
      "label": "年龄门槛",
      "status": "satisfied/unsatisfied/unknown",
      "summary": "是否满足年龄门槛；超过 35 岁默认不满足，内部定制需求另有说明时优先",
      "reason": "判断依据",
      "followUp": "信息不明确时的追问"
    },
    "education": {
      "label": "学历门槛",
      "status": "satisfied/unsatisfied/unknown",
      "summary": "是否满足学历门槛",
      "reason": "判断依据",
      "followUp": "信息不明确时的追问"
    }
  },
  "experienceAnalysis": {
    "oneLineProfile": "一句话说清楚候选人是干什么的",
    "matchedProjects": [
      {
        "project": "项目名或经历名",
        "reason": "为什么匹配当前岗位",
        "valueLevel": "high/medium/low"
      }
    ],
    "mismatchedProjects": [
      {
        "project": "项目名或经历名",
        "reason": "为什么和岗位核心要求关联弱"
      }
    ],
    "overclaimRisks": [
      {
        "claim": "疑似包装或唬人的表述",
        "reason": "为什么判断为包装风险"
      }
    ],
    "highValueSignals": ["有含金量的信号"]
  },
  "objectiveAnalysis": {
    "education": {
      "summary": "学历客观描述",
      "risk": "学历相关风险或无明显风险"
    },
    "ageAndExperience": {
      "summary": "年龄与工作经验是否匹配",
      "risk": "异常点或无明显异常"
    },
    "employmentStatus": {
      "summary": "离职状态、空窗期或当前状态",
      "followUp": "需要追问的问题"
    }
  },
  "elimination": {
    "shouldReject": false,
    "reasons": ["如果建议淘汰，列出淘汰理由"]
  },
  "interviewQuestions": ["针对性追问问题"],
  "copyableConclusion": "适合复制到招聘备注栏的短结论"
}

判断标准：
- 岗位知识库中的 internalRequirements 是高优先级要求；如果与 JD 冲突，以 internalRequirements 为准。
- matchScore 必须等于 scoreBreakdown 五个维度得分之和，总分 100 分：内部定制需求 30、核心经历 30、关键技能 15、稳定性 10、行业/业务理解 15。
- 年龄和学历是门槛项，不计入总分；年龄超过 35 岁默认标记为 unsatisfied，除非内部定制需求明确放宽。
- 年龄或学历门槛不满足时，推荐至少降为“谨慎面试”；严重不满足岗位硬要求时可给“建议淘汰”。
- 简历未体现年龄或学历时标记为 unknown，不要扣分，不要编造。
- candidateName 只能从简历文本中明确出现的人名提取，不能使用“自定义添加”“打招呼”“沟通”等页面操作文案，也不能猜测。
- 有含金量：角色清楚、负责边界清楚、有复杂问题、有业务结果或指标变化、有上线规模、有具体产品/技术/业务决策。
- 疑似包装：只堆关键词、个人贡献模糊、只写参与/负责但无细节、项目名很大但职责很虚、热词多但没有指标/流程/落地结果。
- 如果简历中缺少年龄、学历、离职时间等信息，不要编造，写“简历未明确体现”。
- 只分析当前岗位，不推荐其他岗位。`
    }
  ];
}
