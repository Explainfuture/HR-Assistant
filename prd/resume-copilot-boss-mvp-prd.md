# Resume Copilot BOSS MVP PRD

## 1. Problem Statement

招聘 HR 在 BOSS 直聘查看候选人时，需要快速判断候选人与当前岗位是否匹配。现有流程通常依赖人工阅读简历、对照 JD、记录备注，效率低且判断标准容易不一致。

Resume Copilot 的第一版目标是做一个 Chrome 插件原型：在 HR 打开 BOSS 候选人简历弹层后，手动抓取弹层中已经由 BOSS 解析出的简历文字，并结合用户维护的岗位 JD 知识库，调用 DeepSeek 生成结构化分析报告，帮助 HR 快速判断是否进入下一轮。

## 2. MVP Scope

### In Scope

- Chrome Extension Manifest V3。
- BOSS 直聘 HR 候选人简历弹层文本采集。
- 插件侧边栏上传 PDF 简历，并在本地提取 PDF 文本。
- 插件侧边栏中手动点击“抓取并分析”。
- Options 页面配置 DeepSeek API Key。
- Options 页面粘贴 JD 文本，并调用 DeepSeek 生成岗位知识库 JSON。
- 岗位知识库 JSON 保存到 `chrome.storage.local`。
- 用户可以编辑、保存、删除岗位知识库 JSON。
- BOSS 侧边栏下拉选择一个岗位知识库。
- 只按当前手动选择的岗位分析候选人，不做自动岗位推荐。
- 输出匹配岗位、经验分析、客观分析、淘汰理由、面试追问、可复制备注总结。

### Out of Scope

- 账号体系、团队协作、服务端同步。
- 后端代理 API。
- Moka 或其他招聘平台适配。
- OCR 扫描件或图片简历解析。
- 自动监听候选人变化并自动分析。
- 自动扫描所有岗位并推荐最佳岗位。
- 薪资和职级判断。
- 企业级 API Key 安全方案。

## 3. Primary User Flow

1. 用户进入插件 Options 页面。
2. 用户填写 DeepSeek API Key。
3. 用户粘贴一个岗位 JD。
4. 用户点击“生成岗位 JSON”。
5. 插件调用 DeepSeek，将 JD 结构化为岗位知识库 JSON。
6. 用户检查并手动修改 JSON。
7. 用户保存岗位知识库。
8. 用户打开 BOSS 直聘候选人简历弹层。
9. 用户打开插件侧边栏。
10. 用户从下拉框选择一个岗位。
11. 用户点击“抓取并分析”。
12. 插件展开并滚动 BOSS 简历弹层，采集候选人简历文本。
13. 插件将岗位 JSON 和简历文本发送给 DeepSeek。
14. 插件展示分析报告。
15. 用户复制备注总结，粘贴到招聘平台备注栏。

PDF 上传分支：

1. 用户在侧边栏选择岗位。
2. 用户上传 PDF 简历。
3. 插件本地提取 PDF 文本。
4. 插件将岗位 JSON 和 PDF 简历文本发送给 DeepSeek。
5. 插件复用同一套分析报告展示和复制流程。

## 4. Functional Requirements

### 4.1 Options: API Settings

- 用户可以输入 DeepSeek API Key。
- 默认模型为 `deepseek-v4-pro`。
- API Key 保存到 `chrome.storage.local`。
- 页面应提示：API Key 存储在本机插件存储中，适合个人原型，不是企业级密钥管理方案。

### 4.2 Options: Job Knowledge Base

- 用户可以粘贴 JD 文本。
- 用户点击生成后，插件调用 DeepSeek 提取岗位知识库 JSON。
- 用户可以直接编辑生成后的 JSON。
- 用户可以保存、更新、删除岗位知识库。
- 保存后的岗位会出现在 BOSS 侧边栏的岗位下拉框里。

岗位知识库 JSON 建议结构：

```json
{
  "id": "uuid",
  "title": "AI产品经理",
  "jd": "原始JD全文",
  "mustHave": ["必须有AI产品落地经验", "能独立推进需求分析和项目上线"],
  "niceToHave": ["有大模型应用经验", "有B端产品经验"],
  "riskFlags": ["只堆AI关键词但没有落地细节", "项目贡献边界不清楚"],
  "interviewFocus": ["真实负责边界", "项目指标", "AI能力深度"],
  "updatedAt": "2026-05-14T00:00:00.000Z"
}
```

### 4.3 BOSS Sidebar

- 插件侧边栏在 BOSS 页面可用。
- 侧边栏提供岗位下拉框。
- 侧边栏提供“抓取并分析”按钮。
- 分析过程中展示 loading 状态。
- 如果没有配置 API Key，应提示用户去 Options 配置。
- 如果没有岗位知识库，应提示用户去 Options 新增岗位。
- 如果没有检测到候选人简历弹层，应提示用户先打开候选人详情。

### 4.4 Resume Text Capture

第一版采集目标包含两类文本来源：BOSS 候选人弹层中已经解析出的简历文字，以及用户手动上传的 PDF 简历文本。不处理扫描件、图片简历或 OCR。

采集策略：

- 定位候选人简历弹层或详情容器。
- 点击容器内可见的“展开”“查看更多”“完整经历”等按钮。
- 滚动候选人详情容器到底部。
- 每次滚动后等待内容变化。
- 当文本长度和滚动高度连续多轮不变时停止。
- 对采集到的文本做去重、清洗和拼接。
- 只采集当前候选人的详情文本，避免混入页面导航、聊天列表、推荐候选人等无关内容。

### 4.5 Candidate Analysis

分析输入：

- 当前手动选择的岗位知识库 JSON。
- 当前候选人的简历文本。

分析目标：

- 判断候选人是否匹配该岗位。
- 识别匹配项目和不匹配项目。
- 判断哪些经历有含金量，哪些描述疑似包装。
- 做客观分析，包括学历、年龄与工作经验一致性、离职状态和需要追问的问题。
- 如果建议淘汰，明确说明淘汰理由。
- 不评价薪资和职级。

“有含金量”的判断标准：

- 角色清楚。
- 负责边界清楚。
- 有复杂问题。
- 有业务结果或指标变化。
- 有上线规模。
- 有具体产品、技术或业务决策。

“疑似包装”的判断标准：

- 只堆关键词。
- 个人贡献模糊。
- 只写“参与”“负责”，但没有细节。
- 项目名很大，但职责很虚。
- AI、大模型、中台、增长等热词很多，但没有指标、流程或落地结果。

## 5. Analysis Output Contract

DeepSeek 应返回严格 JSON，插件再渲染成人类可读报告。

```json
{
  "matchedRole": {
    "roleId": "knowledge-base-id",
    "roleName": "AI产品经理",
    "matchScore": 82,
    "recommendation": "建议面试"
  },
  "experienceAnalysis": {
    "oneLineProfile": "候选人主要做过B端AI产品和数据平台，偏需求分析与项目推进。",
    "matchedProjects": [
      {
        "project": "智能客服平台",
        "reason": "与JD中的大模型应用落地、业务流程设计匹配。",
        "valueLevel": "high"
      }
    ],
    "mismatchedProjects": [
      {
        "project": "后台管理系统",
        "reason": "更偏常规后台功能，和岗位核心要求关联较弱。"
      }
    ],
    "overclaimRisks": [
      {
        "claim": "负责AI算法优化",
        "reason": "描述中没有模型、指标、实验或技术决策，可能只是对接算法团队。"
      }
    ],
    "highValueSignals": [
      "能讲清楚业务指标和产品闭环",
      "有从0到1上线经验"
    ]
  },
  "objectiveAnalysis": {
    "education": {
      "summary": "本科，院校一般。",
      "risk": "无明显风险"
    },
    "ageAndExperience": {
      "summary": "年龄与工作年限基本匹配。",
      "risk": "无明显异常"
    },
    "employmentStatus": {
      "summary": "简历显示已离职。",
      "followUp": "需要追问离职原因、空窗期和当前求职节奏。"
    }
  },
  "elimination": {
    "shouldReject": false,
    "reasons": []
  },
  "interviewQuestions": [
    "你在智能客服平台中具体负责哪些模块？哪些决策是你主导的？",
    "项目上线后用什么指标验证效果？"
  ],
  "copyableConclusion": "候选人整体匹配AI产品经理岗位，建议进入面试，重点追问项目中的真实负责边界、AI能力深度和离职原因。"
}
```

## 6. UX Requirements

### Options Page

- API 设置区和岗位知识库区分开。
- JD 粘贴框应支持长文本。
- JSON 编辑区应支持格式化和校验。
- 保存失败时显示明确错误。
- 生成岗位 JSON 失败时保留原始 JD，不丢失用户输入。

### BOSS Sidebar

- 第一屏应直接展示岗位选择和分析按钮。
- 报告按以下模块展示：
  - 匹配岗位。
  - 经验分析。
  - 客观分析。
  - 淘汰理由。
  - 面试追问。
  - 复制总结。
- “复制总结”应复制适合粘贴到招聘备注栏的短文本。

## 7. Technical Modules

### Extension Shell

- `manifest.json`
- background service worker
- content script
- side panel or injected sidebar
- options page

### Storage Module

负责读写：

- DeepSeek API Key。
- 模型配置。
- 岗位知识库列表。

建议对外提供简单接口：

- `getSettings()`
- `saveSettings(settings)`
- `listJobProfiles()`
- `saveJobProfile(profile)`
- `deleteJobProfile(id)`

### DeepSeek Client

负责：

- 生成岗位知识库 JSON。
- 分析候选人简历。
- 处理 JSON 输出校验。
- 处理 API 错误、超时、空响应。

### BOSS Resume Extractor

负责：

- 检测候选人弹层。
- 展开折叠内容。
- 滚动详情容器。
- 提取文本。
- 清洗和去重。

### Report Renderer

负责：

- 将分析 JSON 渲染为侧边栏报告。
- 生成可复制备注。

## 8. Development Tasks

1. 搭建 Chrome Extension MV3 项目结构。
2. 创建 Options 页面。
3. 实现 `chrome.storage.local` 读写模块。
4. 实现 DeepSeek API Key 保存和读取。
5. 实现 JD 粘贴、岗位 JSON 生成、JSON 编辑、保存和删除。
6. 创建 BOSS 页面 content script。
7. 实现 BOSS 候选人弹层检测。
8. 实现展开、滚动、文本采集和去重。
9. 创建侧边栏 UI。
10. 实现岗位下拉选择。
11. 实现手动“抓取并分析”流程。
12. 实现 DeepSeek 候选人分析调用。
13. 实现分析 JSON 校验和错误处理。
14. 实现报告展示。
15. 实现复制备注总结。
16. 用真实 BOSS 候选人页面手动验证采集质量。

## 9. Testing Decisions

优先测试外部行为，不测试实现细节。

建议覆盖：

- Storage 模块：保存、读取、更新、删除岗位知识库。
- DeepSeek prompt builder：输入 JD 或简历时能生成稳定的请求结构。
- JSON parser：能处理合法 JSON、包裹在 markdown code block 中的 JSON、非法 JSON。
- Resume text cleaner：能去重、去空行、过滤明显导航噪声。
- BOSS extractor：在保存的 DOM fixture 上能提取候选人简历文本。

MVP 阶段可接受部分 BOSS 页面适配通过人工测试验证，因为真实页面 DOM 可能依赖登录态和线上环境。

## 10. Open Risks

- BOSS 页面 DOM 结构可能频繁变化，文本采集器需要尽量依赖候选人弹层范围和文本特征，而不是过度依赖脆弱选择器。
- DeepSeek 返回内容可能不是严格 JSON，需要做容错解析和错误提示。
- API Key 存在本地插件存储中，仅适合个人原型。
- 如果候选人简历内容由图片、canvas 或附件承载，MVP 不解析。
