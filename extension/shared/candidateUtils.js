import { compactText } from "./jsonUtils.js";

const NAME_LABEL_RE = /(?:姓名|候选人|人才)[:：\s]+([\u4e00-\u9fa5·]{2,8})/;
const CHINESE_NAME_RE = /^[\u4e00-\u9fa5·]{2,6}$/;
const NOISE_RE =
  /boss|直聘|沟通|在线|简历|求职|附件|工作经历|教育经历|项目经历|个人优势|自我评价|岗位|职位|浏览|联系|期望|学历|年龄|经验|优势|技能|公司|项目|作品|上传|解析|自定义|添加|打招呼|交换|电话|微信|立即|查看|收藏|备注|编辑|男|女/i;

export function inferCandidateName(resumeText, fallback = "") {
  const text = String(resumeText || "");
  const labeled = text.match(NAME_LABEL_RE)?.[1];
  if (isLikelyName(labeled)) return labeled;

  const lines = text
    .split(/\r?\n/)
    .map((line) => compactText(line))
    .filter(Boolean)
    .slice(0, 80);

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

function isLikelyName(value) {
  const name = compactText(value);
  return CHINESE_NAME_RE.test(name) && !NOISE_RE.test(name);
}
