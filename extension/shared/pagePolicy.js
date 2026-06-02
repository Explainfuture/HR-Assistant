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
    const applicationId = parsed.pathname.match(MOKA_CANDIDATE_APPLICATION_ID_RE)?.[1];
    return applicationId ? `moka:application:${applicationId}` : "";
  }

  return "";
}

function parseHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /^https?:$/i.test(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}
