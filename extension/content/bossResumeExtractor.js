(function () {
  const MESSAGE_TYPE = "RESUME_COPILOT_EXTRACT_RESUME";
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
      rawLength: 0
    };

    const scroller = findBestScroller(container);
    let previousSignature = "";
    let stableRounds = 0;
    let rawText = "";

    for (let round = 0; round < 10; round += 1) {
      debug.expandedClicks += clickExpandControls(container);
      await wait(260);

      rawText = collectText(container);
      const scrollInfo = scrollToBottom(scroller || container);
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

    rawText = collectText(container);
    debug.rawLength = rawText.length;

    const text = cleanResumeText(rawText);
    if (text.length < 80) {
      throw new Error("采集到的文本过短，请确认当前页面已打开候选人简历详情");
    }

    return {
      ok: true,
      text,
      debug
    };
  }

  function findCandidateContainer() {
    const selectors = [
      '[role="dialog"]',
      ".dialog-container",
      ".dialog-wrap",
      ".modal",
      ".modal-content",
      ".drawer",
      ".side-dialog",
      ".resume-detail",
      ".resume-container",
      ".geek-detail",
      ".candidate-detail",
      ".detail-card",
      ".recommend-card",
      ".boss-popup",
      ".pop-wrap"
    ];

    const candidates = [...document.querySelectorAll(selectors.join(","))]
      .filter(isVisible)
      .filter((node) => collectText(node).length > 120);

    const scored = candidates
      .map((node) => ({ node, score: scoreResumeContainer(node) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored[0]) return scored[0].node;

    const bodyScore = scoreResumeContainer(document.body);
    return bodyScore > 0 ? document.body : null;
  }

  function scoreResumeContainer(node) {
    const text = collectText(node);
    if (text.length < 120) return 0;

    let score = Math.min(text.length / 100, 120);
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
    const nodes = [container, ...container.querySelectorAll("*")];
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

  function scrollToBottom(node) {
    const before = node.scrollTop;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = max;

    if (node === document.body || node === document.documentElement) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
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
