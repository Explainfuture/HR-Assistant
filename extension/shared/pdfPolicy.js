const TEXT_ONLY_MIN_LENGTH = 800;

export function shouldRenderPdfPageImages(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  return compact.length < TEXT_ONLY_MIN_LENGTH;
}

