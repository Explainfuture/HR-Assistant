import { compactText } from "./jsonUtils.js";

const NAME_LABEL_RE =
  /(?:姓名|候选人|人才|name|candidate)[:：\s]+([\u4e00-\u9fa5·]{2,8}|[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/i;
const CHINESE_NAME_RE = /^[\u4e00-\u9fa5·]{2,6}$/;
const ENGLISH_NAME_RE = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/;
const DISPLAY_NAME_RE = /^[a-z][a-z0-9._-]{2,31}$/i;
const LINE_HEAD_DISPLAY_NAME_RE =
  /^([a-z][a-z0-9._-]{2,31})(?=\s*(?:\d{2}\s*岁|[|｜]|本科|硕士|博士|大专|应届|在职|离职|求职|期望|$))/i;
const LINE_HEAD_ENGLISH_NAME_RE =
  /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})(?=\s*(?:$|[|｜,，]|(?:\+?\d[\d\s().-]{6,})|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|本科|硕士|博士|Bachelor|Master|PhD|Engineer|Developer|Designer|Manager))/;
const NOISE_RE =
  /boss|直聘|沟通|在线|简历|求职|附件|工作经历|教育经历|项目经历|个人优势|自我评价|岗位|职位|浏览|联系|期望|学历|年龄|经验|优势|技能|公司|项目|作品|上传|解析|自定义|添加|打招呼|交换|电话|微信|立即|查看|收藏|备注|编辑|男|女/i;
const NOT_NAME_RE =
  /公司|有限|集团|科技|投资|资本|大学|学院|本科|硕士|博士|大专|双一流|一流大学|工程师|开发|产品|运营|经理|实习|经历|内容|项目|前端|后端|全栈|算法|数据|java|react|typescript|python|fastapi|engineer|developer|manager|designer|consultant|intern|university|college|school|company|limited|inc|llc|corp|group|technology|software|resume|curriculum|vitae|profile|summary|experience|education|skills|project/i;
const MOKA_TAB_NAME_RE =
  /^(?:人才推荐|招聘职位|候选人管理|用人部门筛选|推荐给用人部门|初筛|面试|Offer\/录用|Offer录用|操作记录|附加信息|基本信息|历史标签|当前网页简历|岗位列表|岗位推荐|待入职|已入职|未推荐|已推荐|未淘汰|已淘汰|待处理|待分配)$/i;
const ENGLISH_NAME_STOP_WORD_RE =
  /^(Engineer|Developer|Manager|Designer|Consultant|Intern|University|College|School|Company|Technology|Software|Resume|Profile|Experience|Education|Skills|Project|Bachelor|Master|PhD|Senior|Junior|Frontend|Backend|Fullstack|Product|Data)$/i;

export function inferCandidateName(resumeText, fallback = "") {
  const text = String(resumeText || "");
  const labeled = text.match(NAME_LABEL_RE)?.[1];
  if (isLikelyName(labeled)) return labeled;

  const lines = text
    .split(/\r?\n/)
    .map((line) => compactText(line))
    .filter(Boolean)
    .slice(0, 80);

  const englishName = lines.map(extractEnglishNameFromLine).find(Boolean);
  if (englishName) return englishName;

  const displayName = lines.map(extractDisplayNameFromLine).find(Boolean);
  if (displayName) return displayName;

  const nameLine = lines.find((line) => isLikelyName(line));
  if (nameLine) return nameLine;

  const fallbackName = compactText(fallback)
    .replace(/\.(pdf|docx?|txt)$/i, "")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .find((part) => isLikelyName(part));

  return fallbackName || "姓名未识别";
}

export function isCandidateNameRecognized(candidateName) {
  return isLikelyName(candidateName) && candidateName !== "姓名未识别";
}

export function isResumeTagLikeCandidateName(candidateName) {
  return isResumeTagLikeName(compactText(candidateName));
}

function isLikelyName(value) {
  const name = compactText(value);
  if (isResumeTagLikeName(name)) return false;
  if (CHINESE_NAME_RE.test(name)) return !NOISE_RE.test(name) && !NOT_NAME_RE.test(name);
  if (ENGLISH_NAME_RE.test(name)) return !NOISE_RE.test(name) && !NOT_NAME_RE.test(name);
  return isLikelyDisplayName(name);
}

function isLikelyDisplayName(value) {
  const name = compactText(value);
  if (!DISPLAY_NAME_RE.test(name)) return false;
  if (isResumeTagLikeName(name)) return false;
  if (NOISE_RE.test(name) || NOT_NAME_RE.test(name)) return false;
  return !/^(admin|user|test|null|undefined|resume|candidate|boss|hr)$/i.test(name);
}

function isResumeTagLikeName(name) {
  return MOKA_TAB_NAME_RE.test(name) || /^(?:qs\d+|c9|985|211)$/i.test(name) || /^[A-Z0-9]{3,8}$/.test(name);
}

function extractDisplayNameFromLine(line) {
  const match = compactText(line).match(LINE_HEAD_DISPLAY_NAME_RE)?.[1];
  return isLikelyDisplayName(match) ? match : "";
}

function extractEnglishNameFromLine(line) {
  const normalized = compactText(line);
  if (normalized.length > 96) return "";
  const match = normalized.match(LINE_HEAD_ENGLISH_NAME_RE)?.[1];
  return normalizeEnglishNameCandidate(match);
}

function normalizeEnglishNameCandidate(value) {
  const words = compactText(value).split(/\s+/).filter(Boolean);
  const kept = [];
  for (const word of words) {
    if (ENGLISH_NAME_STOP_WORD_RE.test(word)) break;
    kept.push(word);
  }
  const candidate = kept.join(" ");
  return isLikelyName(candidate) ? candidate : "";
}
