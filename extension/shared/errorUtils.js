export const ERROR_TYPES = {
  COLLECT_EMPTY: "COLLECT_EMPTY",
  PDF_TEXT_EMPTY: "PDF_TEXT_EMPTY",
  PDF_RENDER_FAILED: "PDF_RENDER_FAILED",
  IMAGE_ENCODE_FAILED: "IMAGE_ENCODE_FAILED",
  MODEL_EMPTY_RESPONSE: "MODEL_EMPTY_RESPONSE",
  MODEL_JSON_INVALID: "MODEL_JSON_INVALID",
  JOB_PROFILE_EMPTY: "JOB_PROFILE_EMPTY",
  TASK_INTERRUPTED: "TASK_INTERRUPTED",
  SETTINGS_MISSING: "SETTINGS_MISSING",
  UNKNOWN: "UNKNOWN"
};

export function normalizeTaskError(error) {
  const message = error?.message || String(error || "");
  return {
    type: classifyError(message),
    message: message || "任务失败，请重试"
  };
}

export function classifyError(message) {
  const text = String(message || "");
  if (/api key|doubao api key|配置/i.test(text)) return ERROR_TYPES.SETTINGS_MISSING;
  if (/岗位知识库|选择.*岗位|profile/i.test(text)) return ERROR_TYPES.JOB_PROFILE_EMPTY;
  if (/PDF text is too short|PDF.*过短|PDF.*文字/i.test(text)) return ERROR_TYPES.PDF_TEXT_EMPTY;
  if (/render|渲染.*失败/i.test(text)) return ERROR_TYPES.PDF_RENDER_FAILED;
  if (/图片.*识别.*过短|图片.*简历|image/i.test(text)) return ERROR_TYPES.IMAGE_ENCODE_FAILED;
  if (/Doubao.*返回为空|返回为空|empty response/i.test(text)) return ERROR_TYPES.MODEL_EMPTY_RESPONSE;
  if (/JSON|parse|未找到有效/i.test(text)) return ERROR_TYPES.MODEL_JSON_INVALID;
  if (/interrupted|service worker|浏览器回收|任务中断/i.test(text)) return ERROR_TYPES.TASK_INTERRUPTED;
  if (/文本.*过短|采集.*过短|采集失败|当前网页/i.test(text)) return ERROR_TYPES.COLLECT_EMPTY;
  return ERROR_TYPES.UNKNOWN;
}
