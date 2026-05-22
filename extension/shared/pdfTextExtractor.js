import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdfjs/pdf.worker.min.mjs"
);

const CMAP_URL = chrome.runtime.getURL("vendor/pdfjs/cmaps/");
const STANDARD_FONT_DATA_URL = chrome.runtime.getURL("vendor/pdfjs/standard_fonts/");
const MAX_RENDERED_PAGES = 8;
const MAX_IMAGE_EDGE = 1800;
const IMAGE_QUALITY = 0.86;

export async function extractTextFromPdfFile(file) {
  if (!file) {
    throw new Error("请先选择 PDF 简历");
  }
  if (file.type && file.type !== "application/pdf") {
    throw new Error("请选择 PDF 文件");
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    isEvalSupported: false,
    useWorkerFetch: false
  });
  const pdf = await task.promise;
  const pages = [];
  const imageUrls = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(cleanPdfText(text));

    if (imageUrls.length < MAX_RENDERED_PAGES) {
      const imageUrl = await renderPageToImageUrl(page);
      if (imageUrl) imageUrls.push(imageUrl);
    }
  }

  const text = cleanPdfText(pages.join("\n\n"));
  if (text.length < 80 && !imageUrls.length) {
    throw new Error("PDF text is too short and page image rendering failed; OCR cannot be submitted.");
  }

  return {
    text: text.slice(0, 60000),
    imageUrls,
    pageCount: pdf.numPages
  };
}

async function renderPageToImageUrl(page) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2, MAX_IMAGE_EDGE / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return "";

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({
    canvasContext: context,
    viewport
  }).promise;

  return canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
}

function cleanPdfText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
