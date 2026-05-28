export function createResumeFingerprint(resume = {}) {
  const text = normalizeResumeTextForFingerprint(resume.text || resume.resumeText || "");
  const imageUrls = Array.isArray(resume.imageUrls) ? resume.imageUrls : [];
  const imageSample = imageUrls.map(normalizeImageForFingerprint).filter(Boolean).join("|");

  if (!text && !imageSample) return "";

  const textSample = text
    ? `${text.length}:${text.slice(0, 2200)}:${text.slice(-2200)}`
    : "";

  return `rf_${hashString(`${textSample}|${imageSample}`)}`;
}

export function normalizeResumeTextForFingerprint(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeImageForFingerprint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^data:image\//i.test(raw)) {
    return `data:${raw.length}:${raw.slice(0, 96)}:${raw.slice(-96)}`;
  }

  if (/^blob:/i.test(raw)) {
    return `blob:${raw.length}:${raw.slice(-120)}`;
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.slice(0, 240);
  }
}

function hashString(value) {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;

  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}
