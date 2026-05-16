# Resume Copilot BOSS MVP PRD

## 1. Problem Statement

招聘 HR 在 BOSS 直聘查看候选人简历时，需要快速判断候选人适合哪个岗位，以及是否值得进入下一轮。旧流程要求 HR 先手动选择一个岗位再分析，适合单岗位筛选，但不适合一个候选人可能同时适配多个岗位的场景。

新版本需要在看到简历后先自动匹配一个最合适的岗位，同时保留 HR 手动切换目标岗位重新评估的能力。

## 2. MVP Scope

### In Scope

- Chrome Extension Manifest V3。
- BOSS 候选人简历弹层文本采集。
- 侧栏上传 PDF 简历，并在本地提取 PDF 文本。
- Options 页面配置 DeepSeek API Key。
- Options 页面维护岗位知识库。
- 岗位知识库支持大类：研发、产品、市场、销售、职能。
- 市场包含运营、PR、品牌、投放等岗位。
- 销售包含销售、解决方案、交付经理等岗位。
- 职能包含采购、HR 等岗位。
- 用户保存岗位时可编辑岗位大类。
- 侧栏可以按大类筛选岗位。
- 侧栏可以把当前候选人提交到后台任务队列。
- HR 可以连续打开多个候选人简历，每打开一个人提交一次分析任务。
- 提交后任务在 background 中排队/并发处理，侧栏不需要停在当前候选人。
- 侧栏可以自动匹配当前简历到一个最佳岗位。
- 自动匹配时并发评估多个候选岗位，并展示候选岗位评分列表。
- 自动匹配后，用户可以手动切换岗位，用当前简历重新评估。
- 仍然支持手动选择岗位后直接分析 BOSS 页面或 PDF。
- 本地保存最近解析历史，便于查看已经分析过的候选人。
- 历史入口必须是按钮，点击后打开独立扩展历史页，而不是停留在侧栏内。
- 历史列表必须展示候选人姓名。
- 用户可以清空本地解析历史。
- Options 页面需要提供关闭按钮，便于从完整页面返回当前招聘流程。
- 输出匹配岗位、经验分析、客观分析、淘汰理由、面试追问、可复制备注总结。

### Out of Scope

- 账号体系、团队协作、服务端同步。
- 后端代理 API。
- 自动监听候选人变化并自动分析。
- OCR 扫描件或图片简历解析。
- 薪资和职级判断。
- 企业级 API Key 安全方案。

## 3. Primary User Flow

1. 用户在 Options 页面保存 DeepSeek API Key。
2. 用户粘贴 JD，生成岗位知识库 JSON。
3. 系统为岗位生成或推断大类。
4. 用户检查 JSON，必要时手动调整大类。
5. 用户保存岗位知识库。
6. 用户打开 BOSS 候选人简历弹层或上传 PDF。
7. 用户在侧栏选择“全部大类”或某个大类。
8. 用户点击提交后台解析。
9. 插件采集或解析简历文本。
10. 插件把任务提交到 background 队列，HR 可以继续打开下一个候选人。
11. background 按任务并发数处理候选人任务。
12. 自动匹配任务对当前大类下多个岗位并发发起分析。
13. 插件按匹配分数选出最佳岗位并保存完整报告。
14. 插件把分析摘要写入本地解析历史。
15. 用户点击历史按钮，打开类似 Options 的完整历史页面，查看所有已解析候选人。
16. 用户点击某个候选人，查看解析报告。
17. 用户可以清空本地解析历史。
18. 用户复制备注总结，粘贴到招聘平台备注栏。

## 4. Functional Requirements

### 4.1 Job Profile Schema

岗位知识库 JSON 必须支持：

```json
{
  "id": "uuid",
  "title": "AI 产品经理",
  "category": "产品",
  "jd": "原始 JD 全文",
  "mustHave": ["硬性要求"],
  "niceToHave": ["加分项"],
  "riskFlags": ["筛选风险点"],
  "interviewFocus": ["面试重点追问方向"],
  "updatedAt": "2026-05-14T00:00:00.000Z"
}
```

`category` 只能是：研发、产品、市场、销售、职能。老数据没有 `category` 时，插件应根据岗位名和 JD 做兜底推断。

### 4.2 Automatic Matching

- 自动匹配应作为后台任务提交。
- 自动匹配应复用同一次简历采集结果。
- 自动匹配应在当前筛选大类下运行；如果选择全部大类，则评估全部岗位。
- 自动匹配对多个岗位并发调用 DeepSeek，MVP 默认并发数为 3。
- 部分岗位评估失败时，不应导致全部失败；只要有成功结果，就展示最佳成功结果，并提示失败数量。
- 最佳岗位按 `matchedRole.matchScore` 选择。
- 自动匹配完成后，岗位下拉框应切换到最佳岗位。

### 4.3 Manual Re-evaluation

- 用户可以手动选择任意岗位并重新分析 BOSS 页面或 PDF。
- 当已有最近一次简历文本时，用户可以不重新采集，直接用当前简历评估所选岗位。
- 手动复评仍输出完整报告。

### 4.4 Local Analysis History

- 每次分析成功后，应在 `chrome.storage.local` 保存一条轻量历史记录。
- 历史记录只保存展示所需摘要，不保存完整简历全文。
- 历史记录包含：候选人显示名、来源、分析时间、岗位大类、岗位名、匹配分、建议、可复制结论摘要、简历预览。
- 候选人显示名必须优先解析真实姓名。
- 侧栏首页只展示历史入口按钮。
- 点击历史按钮后打开 `history/history.html`，展示所有本地历史。
- 本地最多保留最近 50 条历史。
- 用户可以点击清空历史按钮删除全部本地解析历史。

### 4.5 Background Task Queue

- 侧栏负责采集 BOSS/PDF 简历文本并提交任务。
- background 负责读取配置、读取岗位知识库、调用 DeepSeek、保存历史。
- 任务状态包含：排队中、处理中、已完成、失败。
- 侧栏应展示最近后台任务状态。
- MVP 默认候选人任务并发数为 2。

### 4.6 Analysis Output Contract

DeepSeek 应返回严格 JSON：

```json
{
  "matchedRole": {
    "roleId": "knowledge-base-id",
    "roleName": "AI 产品经理",
    "matchScore": 82,
    "recommendation": "建议面试"
  },
  "experienceAnalysis": {
    "oneLineProfile": "候选人主要做过 B 端 AI 产品和数据平台。",
    "matchedProjects": [],
    "mismatchedProjects": [],
    "overclaimRisks": [],
    "highValueSignals": []
  },
  "objectiveAnalysis": {
    "education": {},
    "ageAndExperience": {},
    "employmentStatus": {}
  },
  "elimination": {
    "shouldReject": false,
    "reasons": []
  },
  "interviewQuestions": [],
  "copyableConclusion": "适合复制到招聘备注栏的短结论"
}
```

## 5. UX Requirements

- 侧栏第一屏展示岗位大类、岗位选择、自动匹配入口和手动分析入口。
- 自动匹配按钮应表达当前输入来源：BOSS 页面或 PDF。
- 报告中展示最佳岗位。
- 自动匹配后展示候选岗位评分列表，便于 HR 判断是否需要手动切换。
- “用当前简历评估所选岗位”按钮在没有当前简历文本前不可用。
- 文案应面向 HR 日常操作，不暴露技术细节。

## 6. Technical Modules

- Storage：读写设置和岗位知识库，并兼容老岗位数据。
- Job Category Normalizer：校验和推断岗位大类。
- Prompt Builder：生成岗位 JSON 时要求模型返回岗位大类。
- DeepSeek Client：提供单岗位分析和多岗位并发分析。
- Side Panel Controller：管理自动匹配、手动分析、手动复评和报告渲染。
- Report Renderer：展示最佳岗位、候选岗位评分、经验分析、客观分析和复制总结。

## 7. Testing Decisions

优先测试外部行为：

- JSON 解析容错。
- 岗位大类推断。
- 岗位知识库老数据兼容。
- DeepSeek 请求结构语法检查。
- 扩展必要文件和 manifest 配置检查。

MVP 阶段真实 BOSS 页面采集仍以人工验证为主，因为页面 DOM 依赖登录态和线上结构。
