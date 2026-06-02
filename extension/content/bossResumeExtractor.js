(function () {
  const MESSAGE_TYPE = "RESUME_COPILOT_EXTRACT_RESUME";
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_IMAGE_EDGE = 1800;
  const MAX_SCROLL_ROUNDS = 40;
  const MOKA_MAX_SCROLL_ROUNDS = 4;
  const MOKA_HOST_RE = /(?:^|\.)mokahr\.(?:com|com\.cn)$/i;
  const MOKA_DETAIL_PATH_RE = /^\/candidates\/applications?\/[^/]+(?:\/.*)?$/i;
  const NAME_LABEL_RE =
    /(?:姓名|候选人|人才|name|candidate)[:：\s]+([\u4e00-\u9fa5·]{2,8}|[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})/i;
  const CHINESE_NAME_RE = /^[\u4e00-\u9fa5·]{2,6}$/;
  const ENGLISH_NAME_RE = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3}$/;
  const DISPLAY_NAME_RE = /^[a-z][a-z0-9._-]{2,31}$/i;
  const LINE_HEAD_DISPLAY_NAME_RE =
    /^([a-z][a-z0-9._-]{2,31})(?=\s*(?:\d{2}\s*岁|[|｜]|本科|硕士|博士|大专|应届|在职|离职|求职|期望|$))/i;
  const LINE_HEAD_ENGLISH_NAME_RE =
    /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})(?=\s*(?:$|[|｜,，]|(?:\+?\d[\d\s().-]{6,})|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|本科|硕士|博士|Bachelor|Master|PhD|Engineer|Developer|Designer|Manager))/;
  const NAME_NOISE_RE =
    /boss|直聘|沟通|在线|简历|求职|附件|工作经历|教育经历|项目经历|个人优势|自我评价|岗位|职位|浏览|联系|期望|学历|年龄|经验|优势|技能|公司|项目|作品|自定义|添加|打招呼|交换|电话|微信|立即|查看|收藏|备注|编辑|男|女/i;
  const NOT_NAME_RE =
    /公司|有限|集团|科技|投资|资本|大学|学院|本科|硕士|博士|大专|双一流|一流大学|工程师|开发|产品|运营|经理|实习|经历|内容|项目|前端|后端|全栈|算法|数据|java|react|typescript|python|fastapi|engineer|developer|manager|designer|consultant|intern|university|college|school|company|limited|inc|llc|corp|group|technology|software|resume|curriculum|vitae|profile|summary|experience|education|skills|project/i;
  const MOKA_TAB_NAME_RE =
    /^(?:人才推荐|招聘职位|候选人管理|用人部门筛选|推荐给用人部门|初筛|面试|Offer\/录用|Offer录用|操作记录|附加信息|基本信息|历史标签|当前网页简历|岗位列表|岗位推荐|待入职|已入职|未推荐|已推荐|未淘汰|已淘汰|待处理|待分配)$/i;
  const ENGLISH_NAME_STOP_WORD_RE =
    /^(Engineer|Developer|Manager|Designer|Consultant|Intern|University|College|School|Company|Technology|Software|Resume|Profile|Experience|Education|Skills|Project|Bachelor|Master|PhD|Senior|Junior|Frontend|Backend|Fullstack|Product|Data)$/i;
  const EXPAND_TEXT_RE = /展开|查看更多|完整经历|显示更多|更多|查看全部|全部展开/;
  const RESUME_KEYWORDS = [
    "工作经历",
    "项目经历",
    "教育经历",
    "个人优势",
    "求职意向",
    "期望职位",
    "工作经验",
    "学历",
    "年龄",
    "离职",
    "在职",
    "技能"
  ];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== MESSAGE_TYPE) return false;

    extractResumeText()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          text: "",
          debug: {},
          error: error.message || String(error)
        });
      });

    return true;
  });

  async function extractResumeText() {
    const container = findCandidateContainer();
    if (!container) {
      throw new Error("未检测到候选人简历弹层");
    }

    const debug = {
      container: describeNode(container),
      expandedClicks: 0,
      scrollRounds: 0,
      rawLength: 0,
      mokaIdentity: null,
      pdfResumeImages: 0
    };

    const mokaIdentity = extractMokaCandidateIdentity();
    const mokaHeaderText = formatMokaIdentityText(mokaIdentity);
    debug.mokaIdentity = mokaIdentity;

    const scroller = findBestScroller(container);
    let previousSignature = "";
    let stableRounds = 0;
    let rawText = "";
    const textSnapshots = [];
    const imageUrlSnapshots = new Set();

    const maxScrollRounds = isMokaCandidateDetailPage() ? MOKA_MAX_SCROLL_ROUNDS : MAX_SCROLL_ROUNDS;
    for (let round = 0; round < maxScrollRounds; round += 1) {
      debug.expandedClicks += clickExpandControls(container);
      await wait(260);

      rawText = collectText(container);
      if (rawText) textSnapshots.push(rawText);
      for (const imageUrl of await collectResumeImageUrls(container)) {
        imageUrlSnapshots.add(imageUrl);
      }
      if (isMokaCandidateDetailPage() && imageUrlSnapshots.size) {
        break;
      }
      const scrollInfo = scrollToNextViewport(scroller || container);
      debug.scrollRounds += 1;
      await wait(scrollInfo.moved ? 520 : 320);

      const signature = `${rawText.length}:${scrollInfo.scrollTop}:${scrollInfo.scrollHeight}`;
      if (signature === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      previousSignature = signature;

      if (!scrollInfo.moved && stableRounds >= 2) break;
      if (stableRounds >= 3) break;
    }

    rawText = mergeTextSnapshots([mokaHeaderText, ...textSnapshots, collectText(container)]);
    debug.rawLength = rawText.length;

    const text = cleanResumeText(rawText);
    for (const imageUrl of await collectResumeImageUrls(container)) {
      imageUrlSnapshots.add(imageUrl);
    }
    const imageUrls = [...imageUrlSnapshots];
    const pdfCaptureDebug = getPdfResumeCaptureDebug(container, imageUrls);
    debug.pdfResumeImages = imageUrls.length;
    debug.pdfResumeRoots = pdfCaptureDebug.rootCount;
    debug.pdfResumeImgTags = pdfCaptureDebug.imgTagCount;
    debug.pdfResumeSampleUrls = pdfCaptureDebug.sampleUrls;
    if (isMokaCandidateDetailPage() && !imageUrls.length) {
      throw new Error("Moka 简历图片还未加载完成");
    }
    if (text.length < 80 && !imageUrls.length) {
      throw new Error("采集到的文本过短，请确认当前页面已打开候选人简历详情");
    }

    return {
      ok: true,
      text,
      imageUrls,
      candidateName: mokaIdentity.name || inferCandidateName(text, container),
      debug
    };
  }


  async function collectResumeImageUrls(container) {
    const candidates = collectResumeImageCandidates(container);
    const urls = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const url = await normalizeResumeImageCandidate(candidate);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }

    return urls;
  }

  function collectResumeImageCandidates(container) {
    const pdfResumeCandidates = collectPdfResumeImageCandidates(container);
    if (isMokaCandidateDetailPage()) {
      const documentPdfResumeCandidates = collectPdfResumeImageCandidates(document);
      const mergedPdfResumeCandidates = dedupeCandidates([
        ...documentPdfResumeCandidates,
        ...pdfResumeCandidates
      ]);
      if (mergedPdfResumeCandidates.length) return mergedPdfResumeCandidates;
    }
    if (pdfResumeCandidates.length) return pdfResumeCandidates;

    const candidates = [];

    for (const img of container.querySelectorAll("img")) {
      for (const url of [
        img.currentSrc,
        img.src,
        ...parseSrcset(img.srcset),
        img.dataset?.src,
        img.dataset?.url,
        img.dataset?.original,
        img.dataset?.lazySrc
      ]) {
        addImageCandidate(candidates, { url, node: img, score: scoreImageNode(img) });
      }
    }

    for (const source of container.querySelectorAll("source")) {
      for (const url of parseSrcset(source.srcset)) {
        addImageCandidate(candidates, { url, node: source, score: 40 });
      }
    }

    for (const link of container.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href");
      if (/\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(href || "")) {
        addImageCandidate(candidates, { url: link.href, node: link, score: 35 });
      }
    }

    for (const node of container.querySelectorAll("[style]")) {
      for (const url of extractCssUrls(node.getAttribute("style"))) {
        addImageCandidate(candidates, { url, node, score: scoreImageNode(node) - 20 });
      }
    }

    for (const canvas of container.querySelectorAll("canvas")) {
      if (!isVisible(canvas)) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 220 || rect.height < 280) continue;
      candidates.push({ canvas, score: rect.width * rect.height + 100000 });
    }

    return candidates
      .filter((candidate) => candidate.canvas || isUsefulImageUrl(candidate.url))
      .sort((a, b) => b.score - a.score);
  }

  function collectPdfResumeImageCandidates(container) {
    const directImageCandidates = collectDirectPdfResumeImageCandidates(container);
    if (directImageCandidates.length) return directImageCandidates;

    const roots = findPdfResumeRoots(container);
    if (!roots.length) return [];

    const candidates = [];
    let order = 0;
    for (const root of roots) {
      const nodes = [root, ...root.querySelectorAll("*")];
      for (const node of nodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLCanvasElement) {
          const rect = node.getBoundingClientRect();
          if (rect.width >= 220 && rect.height >= 280) {
            candidates.push({ canvas: node, score: 200000, order });
            order += 1;
          }
          continue;
        }

        for (const url of collectImageUrlsFromElement(node)) {
          addImageCandidate(candidates, { url, node, score: 200000, order });
          order += 1;
        }
      }
    }

    return dedupeCandidates(
      candidates
        .filter((candidate) => candidate.canvas || isUsefulImageUrl(candidate.url))
        .sort((a, b) => (a.order || 0) - (b.order || 0))
    );
  }

  function collectDirectPdfResumeImageCandidates(scope) {
    const selectors = [
      ".pdf-resume img.img-page[src]",
      ".pdf-resume img[src]",
      "[class*='pdf-resume'] img[src]",
      ".candidate-resume__pdf img[src]",
      "[class*='candidate-resume__pdf'] img[src]"
    ];
    const candidates = [];
    let order = 0;

    for (const img of queryAll(scope, selectors.join(","))) {
      if (!(img instanceof HTMLImageElement)) continue;
      for (const url of [
        img.currentSrc,
        img.src,
        img.getAttribute("src"),
        ...parseSrcset(img.srcset)
      ]) {
        addImageCandidate(candidates, { url, node: img, score: 300000, order });
        order += 1;
      }
    }

    return dedupeCandidates(candidates.sort((a, b) => (a.order || 0) - (b.order || 0)));
  }

  function findPdfResumeRoots(container) {
    const roots = [];
    if (container instanceof Element && isPdfResumeElement(container)) roots.push(container);
    for (const node of queryAll(container, ".pdf-resume,[class*='pdf-resume'],.candidate-resume__pdf,[class*='candidate-resume__pdf']")) {
      if (node instanceof Element && !roots.includes(node)) roots.push(node);
    }
    return roots;
  }

  function getPdfResumeCaptureDebug(container, imageUrls) {
    const scope = isMokaCandidateDetailPage() ? document : container;
    const roots = findPdfResumeRoots(scope);
    const imgTagCount = queryAll(
      scope,
      ".pdf-resume img[src],[class*='pdf-resume'] img[src],.candidate-resume__pdf img[src],[class*='candidate-resume__pdf'] img[src]"
    ).length;
    return {
      rootCount: roots.length,
      imgTagCount,
      sampleUrls: imageUrls.slice(0, 3).map(maskImageUrl)
    };
  }

  function maskImageUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(url || "").slice(0, 120);
    }
  }

  function queryAll(scope, selector) {
    try {
      return [...(scope?.querySelectorAll?.(selector) || [])];
    } catch {
      return [];
    }
  }

  function isPdfResumeElement(node) {
    if (!(node instanceof Element)) return false;
    return /\bpdf-resume\b|candidate-resume__pdf|resume__pdf/i.test(String(node.className || ""));
  }

  function collectImageUrlsFromElement(node) {
    const urls = [];
    if (!(node instanceof Element)) return urls;

    if (node instanceof HTMLImageElement) {
      urls.push(node.currentSrc, node.src, ...parseSrcset(node.srcset));
    }

    const attributeNames = typeof node.getAttributeNames === "function" ? node.getAttributeNames() : [];
    for (const name of attributeNames) {
      const value = node.getAttribute(name);
      if (!value) continue;
      if (/src|href|url|image|file|resume|preview|origin|original|data/i.test(name)) {
        urls.push(...extractLooseImageUrls(value));
      }
    }

    for (const value of Object.values(node.dataset || {})) {
      urls.push(...extractLooseImageUrls(value));
    }

    urls.push(...extractLooseImageUrls(node.textContent));
    urls.push(...extractCssUrls(node.getAttribute("style")));
    try {
      urls.push(...extractCssUrls(getComputedStyle(node).backgroundImage));
    } catch {
      // Ignore nodes detached during Moka virtual list updates.
    }

    return urls.map(normalizeImageUrl).filter(isUsefulImageUrl);
  }

  function dedupeCandidates(candidates) {
    const seen = new Set();
    const deduped = [];
    for (const candidate of candidates) {
      const key = candidate.canvas
        ? `canvas:${candidate.order}:${candidate.canvas.width}x${candidate.canvas.height}`
        : candidate.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped;
  }

  function addImageCandidate(candidates, candidate) {
    const url = normalizeImageUrl(candidate.url);
    if (!url || !isUsefulImageUrl(url)) return;
    candidates.push({ ...candidate, url });
  }

  async function normalizeResumeImageCandidate(candidate) {
    if (candidate.canvas) return canvasToDataUrl(candidate.canvas);

    const directUrl = normalizeImageUrl(
      candidate.url ||
      (candidate.node instanceof HTMLImageElement ? candidate.node.currentSrc || candidate.node.src : "")
    );
    if (isMokaCandidateDetailPage() && isMokaResumeImageUrl(directUrl)) return directUrl;

    const imageDataUrl = candidate.node instanceof HTMLImageElement
      ? imageElementToDataUrl(candidate.node)
      : "";
    if (imageDataUrl) return imageDataUrl;

    const url = directUrl || normalizeImageUrl(candidate.url);
    if (!url) return "";
    if (/^data:image\//i.test(url)) return url.length <= MAX_IMAGE_BYTES * 2 ? url : "";

    const fetchedDataUrl = await fetchImageAsDataUrl(url);
    if (fetchedDataUrl) return fetchedDataUrl;

    return /^https?:\/\//i.test(url) ? url : "";
  }

  function isMokaResumeImageUrl(url) {
    const value = String(url || "");
    if (!/^https?:\/\//i.test(value)) return false;
    return /moka-co-oss\.mokahr\.com/i.test(value) || /(?:^|[/.])[^/?#]+\.pdf_\d+\.(?:jpe?g|png|webp)(?:[?#].*)?$/i.test(value);
  }

  function imageElementToDataUrl(img) {
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return "";
    try {
      const canvas = document.createElement("canvas");
      const { width, height } = fitImageSize(img.naturalWidth, img.naturalHeight);
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch {
      return "";
    }
  }

  function canvasToDataUrl(sourceCanvas) {
    try {
      const { width, height } = fitImageSize(sourceCanvas.width, sourceCanvas.height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(sourceCanvas, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch {
      return "";
    }
  }

  async function fetchImageAsDataUrl(url) {
    if (!/^https?:\/\//i.test(url) && !/^blob:/i.test(url)) return "";
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return "";
      const blob = await response.blob();
      if (!/^image\//i.test(blob.type) || blob.size > MAX_IMAGE_BYTES) return "";
      return await blobToDataUrl(blob);
    } catch {
      return "";
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  }

  function fitImageSize(width, height) {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }

  function scoreImageNode(node) {
    if (!(node instanceof Element)) return 0;
    const rect = node.getBoundingClientRect();
    const text = `${node.getAttribute("alt") || ""} ${node.className || ""} ${node.id || ""}`;
    let score = rect.width * rect.height;
    if (/resume|cv|jianli|简历|附件|pdf|preview/i.test(text)) score += 100000;
    if (rect.width >= 220 && rect.height >= 280) score += 50000;
    return score;
  }

  function scoreResumeVisuals(container) {
    let score = 0;
    for (const img of container.querySelectorAll("img")) {
      const url = img.currentSrc || img.src || "";
      if (!isUsefulImageUrl(url)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width >= 220 && rect.height >= 280) score += rect.width * rect.height;
    }
    for (const canvas of container.querySelectorAll("canvas")) {
      if (!isVisible(canvas)) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= 220 && rect.height >= 280) score += rect.width * rect.height;
    }
    for (const root of findPdfResumeRoots(container)) {
      const rect = root.getBoundingClientRect();
      score += Math.max(1, rect.width) * Math.max(1, Math.min(rect.height, 3000)) + 300000;
    }
    return score;
  }

  function normalizeImageUrl(url) {
    const value = String(url || "").replace(/&amp;/g, "&").trim();
    if (!value) return "";
    if (/^(?:data:image\/|blob:|https?:\/\/)/i.test(value)) return value;
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  }

  function isUsefulImageUrl(url) {
    const value = String(url || "").trim();
    if (!value) return false;
    if (!/^(?:data:image\/|blob:|https?:\/\/)/i.test(value)) return false;
    return !/avatar|icon|logo|qrcode|emoji|sprite|favicon|default|placeholder/i.test(value);
  }

  function extractLooseImageUrls(value) {
    const text = String(value || "").replace(/&amp;/g, "&");
    const urls = [...extractCssUrls(text)];
    const directUrlPattern = /(?:https?:\/\/[^\s"'<>]+|blob:[^\s"'<>]+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)/gi;
    let match = directUrlPattern.exec(text);
    while (match) {
      urls.push(match[0].replace(/[)\],;]+$/g, ""));
      match = directUrlPattern.exec(text);
    }

    if (/\.(?:png|jpe?g|webp)(?:[?#].*)?$/i.test(text.trim())) {
      urls.push(text.trim());
    }

    return urls;
  }

  function parseSrcset(srcset) {
    return String(srcset || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  function extractCssUrls(style) {
    const urls = [];
    const pattern = /url\((['"]?)(.*?)\1\)/gi;
    let match = pattern.exec(String(style || ""));
    while (match) {
      urls.push(match[2]);
      match = pattern.exec(String(style || ""));
    }
    return urls;
  }
  function inferCandidateName(text, container) {
    const labeled = String(text || "").match(NAME_LABEL_RE)?.[1];
    if (isLikelyName(labeled)) return labeled;

    const headingSelectors = [
      ".name",
      ".user-name",
      ".geek-name",
      ".candidate-name",
      ".resume-name",
      ".resume-base-info .name",
      ".geek-name-box",
      '[class*="name"]',
      '[class*="nick"]',
      '[class*="user"]',
      "h1",
      "h2",
      "h3"
    ];
    const headingName = [...container.querySelectorAll(headingSelectors.join(","))]
      .map((node) => normalizeLine(node.textContent))
      .find(isLikelyName);
    if (headingName) return headingName;

    const lines = String(text || "")
      .split(/\n+/)
      .map(normalizeLine)
      .filter(Boolean);

    const englishName = lines.map(extractEnglishNameFromLine).find(Boolean);
    if (englishName) return englishName;

    const displayName = lines.map(extractDisplayNameFromLine).find(Boolean);
    if (displayName) return displayName;

    return lines.find(isLikelyName) || "姓名未识别";
  }

  function isLikelyName(value) {
    const name = normalizeLine(value);
    if (isResumeTagLikeName(name)) return false;
    if (CHINESE_NAME_RE.test(name)) return !NAME_NOISE_RE.test(name) && !NOT_NAME_RE.test(name);
    if (ENGLISH_NAME_RE.test(name)) return !NAME_NOISE_RE.test(name) && !NOT_NAME_RE.test(name);
    return isLikelyDisplayName(name);
  }

  function isLikelyDisplayName(value) {
    const name = normalizeLine(value);
    if (!DISPLAY_NAME_RE.test(name)) return false;
    if (isResumeTagLikeName(name)) return false;
    if (NAME_NOISE_RE.test(name) || NOT_NAME_RE.test(name)) return false;
    return !/^(admin|user|test|null|undefined|resume|candidate|boss|hr)$/i.test(name);
  }

  function isResumeTagLikeName(name) {
    return MOKA_TAB_NAME_RE.test(name) || /^(?:qs\d+|c9|985|211)$/i.test(name) || /^[A-Z0-9]{3,8}$/.test(name);
  }

  function extractDisplayNameFromLine(line) {
    const match = normalizeLine(line).match(LINE_HEAD_DISPLAY_NAME_RE)?.[1];
    return isLikelyDisplayName(match) ? match : "";
  }

  function extractEnglishNameFromLine(line) {
    const normalized = normalizeLine(line);
    if (normalized.length > 96) return "";
    const match = normalized.match(LINE_HEAD_ENGLISH_NAME_RE)?.[1];
    return normalizeEnglishNameCandidate(match);
  }

  function normalizeEnglishNameCandidate(value) {
    const words = normalizeLine(value).split(/\s+/).filter(Boolean);
    const kept = [];
    for (const word of words) {
      if (ENGLISH_NAME_STOP_WORD_RE.test(word)) break;
      kept.push(word);
    }
    const candidate = kept.join(" ");
    return isLikelyName(candidate) ? candidate : "";
  }

  function findCandidateContainer() {
    if (isMokaCandidateListPage()) return null;

    const selectors = [
      ".candidate-resume__container",
      ".candidate-resume__wrapper",
      ".pdf-resume",
      '[class*="candidate-resume"]',
      '[class*="pdf-resume"]',
      '[role="dialog"]',
      ".dialog-container",
      ".dialog-wrap",
      ".modal",
      ".modal-content",
      ".drawer",
      ".side-dialog",
      ".resume-detail",
      ".resume-container",
      ".resume-content",
      ".resume-preview",
      ".resume-viewer",
      ".candidate-resume",
      ".geek-detail",
      ".candidate-detail",
      ".file-preview",
      ".pdf-viewer",
      ".detail-card",
      ".recommend-card",
      ".boss-popup",
      ".pop-wrap",
      ".ant-modal",
      ".ant-drawer",
      '[class*="resume"]',
      '[class*="candidate"]'
    ];

    const candidates = [...document.querySelectorAll(selectors.join(","))]
      .filter(isVisible)
      .filter((node) => collectText(node).length > 120 || scoreResumeVisuals(node) > 0);

    const scored = candidates
      .map((node) => ({ node, score: scoreResumeContainer(node) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored[0]) return scored[0].node;

    const bodyScore = scoreResumeContainer(document.body);
    return bodyScore > 0 ? document.body : null;
  }

  function isMokaCandidateListPage() {
    return MOKA_HOST_RE.test(location.hostname) && /^\/candidates\/?$/i.test(location.pathname);
  }

  function isMokaCandidateDetailPage() {
    return MOKA_HOST_RE.test(location.hostname) && MOKA_DETAIL_PATH_RE.test(location.pathname);
  }

  function extractMokaCandidateIdentity() {
    if (!isMokaCandidateDetailPage()) return { name: "", text: "" };

    const headerText = collectMokaHeaderText();
    return {
      name: inferMokaHeaderName(headerText),
      text: headerText.slice(0, 1200)
    };
  }

  function collectMokaHeaderText() {
    const headerRoot = document.querySelector(".candidate-header-info");
    if (headerRoot instanceof Element && isVisible(headerRoot)) {
      return collectText(headerRoot);
    }

    const resumeRoot = document.querySelector(".pdf-resume,[class*='pdf-resume']");
    const resumeRect = resumeRoot?.getBoundingClientRect?.();
    const topLimit = resumeRect ? Math.max(180, resumeRect.top - 12) : 260;
    const leftLimit = resumeRect ? Math.max(0, resumeRect.left - 360) : window.innerWidth * 0.03;
    const rightLimit = resumeRect ? Math.min(window.innerWidth, resumeRect.right + 420) : window.innerWidth * 0.92;
    const lines = [];
    const seen = new Set();

    for (const node of document.querySelectorAll("h1,h2,h3,span,div,p")) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top < 0 || rect.top > topLimit || rect.left < leftLimit || rect.left > rightLimit) continue;
      const text = normalizeLine(node.innerText || node.textContent || "");
      if (!text || text.length > 180) continue;
      const key = text.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ text, top: rect.top, left: rect.left });
    }

    return lines
      .sort((a, b) => a.top - b.top || a.left - b.left)
      .map((line) => line.text)
      .join("\n");
  }

  function inferMokaHeaderName(headerText) {
    const headerRoot = document.querySelector(".candidate-header-info");
    const headerName = headerRoot instanceof Element ? inferNameFromCandidateHeaderInfo(headerRoot) : "";
    if (headerName) return headerName;

    const lines = String(headerText || "")
      .split(/\n+/)
      .map(normalizeLine)
      .filter(Boolean)
      .slice(0, 30);

    for (const line of lines) {
      const firstToken = line.split(/\s+/)[0];
      if (isLikelyName(firstToken)) return firstToken;
      if (isLikelyName(line)) return line;
    }

    return "";
  }

  function inferNameFromCandidateHeaderInfo(headerRoot) {
    const firstRow = headerRoot.querySelector(".sd-Spacing-wrap,[class*='sd-Spacing-wrap']");
    const candidates = collectNameCandidatesFromNode(firstRow);
    if (!candidates.length) candidates.push(...collectNameCandidatesFromNode(headerRoot));
    return candidates.find(isLikelyName) || "";
  }

  function collectNameCandidatesFromNode(root) {
    if (!(root instanceof Element)) return [];
    const values = [];

    for (const node of root.querySelectorAll("h1,h2,h3,span,div,b,strong")) {
      if (!(node instanceof Element) || !isVisible(node)) continue;
      const text = normalizeLine(node.textContent || "");
      if (!text || text.length > 40) continue;
      for (const token of text.split(/\s+/)) {
        const cleanToken = normalizeNameToken(token);
        if (cleanToken) values.push(cleanToken);
      }
    }

    return values;
  }

  function normalizeNameToken(value) {
    return String(value || "")
      .replace(/[^\u4e00-\u9fa5·A-Za-z.'-\s]/g, "")
      .replace(/[\u730e\u8350\u00a5\uffe5]/g, "")
      .replace(/\u5df2\u7533\u8bf7\d*\u6b21?/g, "")
      .trim();
  }

  function formatMokaIdentityText(identity) {
    if (!identity?.text && !identity?.name) return "";
    return [
      identity.name ? `姓名：${identity.name}` : "",
      identity.text || ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  function scoreResumeContainer(node) {
    const text = collectText(node);
    const visualScore = scoreResumeVisuals(node);
    if (text.length < 120 && visualScore <= 0) return 0;

    let score = Math.min(text.length / 100, 120) + Math.min(visualScore / 10000, 100);
    for (const keyword of RESUME_KEYWORDS) {
      if (text.includes(keyword)) score += 18;
    }

    const rect = node.getBoundingClientRect();
    if (rect.width > 320 && rect.height > 360) score += 30;
    if (rect.left > window.innerWidth * 0.22) score += 12;
    if (node !== document.body && getComputedStyle(node).position === "fixed") score += 20;

    return score;
  }

  function findBestScroller(container) {
    const ancestors = [];
    let current = container.parentElement;
    while (current && current !== document.body) {
      ancestors.push(current);
      current = current.parentElement;
    }
    const nodes = [container, ...ancestors, ...container.querySelectorAll("*")];
    return nodes
      .filter((node) => {
        if (!(node instanceof HTMLElement)) return false;
        if (!isVisible(node)) return false;
        const style = getComputedStyle(node);
        const overflow = `${style.overflowY} ${style.overflow}`;
        return node.scrollHeight > node.clientHeight + 80 && /auto|scroll|overlay/i.test(overflow);
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  }

  function clickExpandControls(container) {
    const controls = [...container.querySelectorAll("button,a,span,div")]
      .filter(isVisible)
      .filter((node) => {
        const text = normalizeLine(node.textContent);
        if (!text || text.length > 24) return false;
        return EXPAND_TEXT_RE.test(text);
      })
      .slice(0, 12);

    let clicks = 0;
    for (const control of controls) {
      try {
        control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        clicks += 1;
      } catch {
        // Ignore controls that cannot be clicked.
      }
    }
    return clicks;
  }

  function scrollToNextViewport(node) {
    const before = node.scrollTop;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const step = Math.max(360, Math.floor(node.clientHeight * 0.85));
    const next = Math.min(max, before + step);
    node.scrollTop = next;

    if (node === document.body || node === document.documentElement) {
      window.scrollTo({ top: next, behavior: "instant" });
    }

    return {
      moved: Math.abs(node.scrollTop - before) > 4,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight
    };
  }

  function collectText(node) {
    return normalizeLine(node.innerText || node.textContent || "");
  }

  function cleanResumeText(text) {
    const seen = new Set();
    const blocked = new Set([
      "登录",
      "注册",
      "首页",
      "消息",
      "职位",
      "推荐",
      "我的",
      "帮助",
      "隐私政策"
    ]);

    const lines = String(text)
      .split(/\n+/)
      .map(normalizeLine)
      .filter(Boolean)
      .filter((line) => line.length > 1)
      .filter((line) => !blocked.has(line));

    const cleaned = [];
    for (const line of lines) {
      const key = line.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(line);
    }

    return cleaned.join("\n").slice(0, 60000);
  }

  function mergeTextSnapshots(snapshots) {
    const seen = new Set();
    const merged = [];

    for (const snapshot of snapshots) {
      for (const line of String(snapshot || "").split(/\n+/).map(normalizeLine).filter(Boolean)) {
        const key = line.replace(/\s+/g, "");
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(line);
      }
    }

    return merged.join("\n");
  }

  function normalizeLine(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isVisible(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      rect.width > 1 &&
      rect.height > 1 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0
    );
  }

  function describeNode(node) {
    if (!node) return "";
    const id = node.id ? `#${node.id}` : "";
    const className =
      typeof node.className === "string"
        ? `.${node.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).join(".")}`
        : "";
    return `${node.tagName.toLowerCase()}${id}${className}`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
