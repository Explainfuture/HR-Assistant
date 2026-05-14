export function buildJobProfileMessages(jdText) {
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
  "jd": "原始JD全文",
  "mustHave": ["硬性要求"],
  "niceToHave": ["加分项"],
  "riskFlags": ["筛选时需要警惕的风险点"],
  "interviewFocus": ["面试重点追问方向"]
}

要求：
- title 从 JD 中提取；如果无法判断，使用最接近的岗位名。
- mustHave 只放真正影响筛选的硬性要求。
- niceToHave 放增强匹配但不是必须的条件。
- riskFlags 要能辅助 HR 判断候选人是否在包装经历。
- interviewFocus 要可用于面试追问。
- 保留 jd 原文。

JD：
${jdText}`
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
  "matchedRole": {
    "roleId": "${jobProfile.id}",
    "roleName": "${jobProfile.title}",
    "matchScore": 0,
    "recommendation": "建议面试/谨慎面试/建议淘汰/需要人工复核"
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
- 有含金量：角色清楚、负责边界清楚、有复杂问题、有业务结果或指标变化、有上线规模、有具体产品/技术/业务决策。
- 疑似包装：只堆关键词、个人贡献模糊、只写参与/负责但无细节、项目名很大但职责很虚、热词多但没有指标/流程/落地结果。
- 如果简历中缺少年龄、学历、离职时间等信息，不要编造，写“简历未明确体现”。
- 只分析当前岗位，不推荐其他岗位。`
    }
  ];
}
