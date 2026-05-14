import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  "vendor/pdfjs/pdf.worker.min.mjs"
);

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
    isEvalSupported: false,
    useWorkerFetch: false
  });
  const pdf = await task.promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(cleanPdfText(text));
  }

  const text = cleanPdfText(pages.join("\n\n"));
  if (text.length < 80) {
    throw new Error("PDF 文字过短，可能是扫描件或图片简历，当前版本暂不支持 OCR");
  }

  return {
    text: text.slice(0, 60000),
    pageCount: pdf.numPages
  };
}

function cleanPdfText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
