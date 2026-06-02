const BOSS_HOST_RE = /(?:^|\.)zhipin\.com$/i;
const MOKA_HOST_RE = /(?:^|\.)mokahr\.(?:com|com\.cn)$/i;
const MOKA_CANDIDATE_DETAIL_PATH_RE = /^\/candidates\/applications?\/[^/]+(?:\/.*)?$/i;
const MOKA_CANDIDATE_APPLICATION_ID_RE = /^\/candidates\/applications?\/([^/]+)/i;

export function isSupportedResumePage(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;

  if (MOKA_HOST_RE.test(parsed.hostname)) {
    return MOKA_CANDIDATE_DETAIL_PATH_RE.test(parsed.pathname);
  }

  return BOSS_HOST_RE.test(parsed.hostname);
}

export function getResumePageKey(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return "";

  if (MOKA_HOST_RE.test(parsed.hostname)) {
    const applicationId = getMokaApplicationId(parsed.href);
    return applicationId ? `moka:application:${applicationId}` : "";
  }

  return "";
}

export function getMokaApplicationId(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed || !MOKA_HOST_RE.test(parsed.hostname)) return "";
  return parsed.pathname.match(MOKA_CANDIDATE_APPLICATION_ID_RE)?.[1] || "";
}

export function getMokaDetailUrl(url) {
  const parsed = parseHttpUrl(url);
  if (!parsed || !MOKA_HOST_RE.test(parsed.hostname)) return "";
  return MOKA_CANDIDATE_DETAIL_PATH_RE.test(parsed.pathname) ? parsed.href : "";
}

function parseHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/i.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}
