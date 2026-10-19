/**
 * El Zatoona — Popup (Phase 3: AI Integration)
 * ---------------------------------------------------------------
 * • Detects the current tab (activeTab) and renders one of 3 states.
 * • Shows the daily free-credits counter, stored ONLY in
 *   chrome.storage.sync (no server, no external API).
 * • On CTA click:
 *     1. checks the built-in AI (window.ai / Gemini Nano) — if it is not
 *        enabled, shows the "enable AI in your browser" screen with the
 *        chrome://flags link and stops there;
 *     2. injects `extractContent()` (src/content/extract.js) into the tab;
 *     3. sends the extracted text + the Arabic prompt to the model
 *        (src/ai/ai.js) and renders the answer in the popup.
 *
 * NOTE (Phase 3): credits are NOT spent yet — that is wired in Phase 4.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DAILY_FREE_CREDITS = 5;

/** CTA labels (also used to reset the button after a cancelled run). */
const PRODUCT_CTA_LABEL = '🌿 إديني زتونة المنتج';
const ARTICLE_CTA_LABEL = '🌿 لخصلّي الزتونة';

/** Storage keys (chrome.storage.sync) */
const STORAGE_KEYS = Object.freeze({
  CREDITS_LEFT: 'creditsLeft',
  CREDITS_DATE: 'creditsDate',
  CREDITS_TOTAL: 'creditsTotal',
});

/**
 * Product pages: Amazon + Noon + Jumia (all locales).
 * Matches root/path domains like amazon.com, amazon.eg, amazon.co.uk, noon.com, noon.ae, jumia.com.eg ...
 */
const PRODUCT_HOST_PATTERNS = Object.freeze([
  /(^|\.)amazon\.[a-z.]{2,}$/i,
  /(^|\.)noon\.[a-z.]{2,}$/i,
  /(^|\.)jumia\.[a-z.]{2,}$/i,
]);

/** Video platforms. */
const VIDEO_HOST_PATTERNS = Object.freeze([
  /(^|\.)youtube\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)vimeo\.com$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
]);

/** Pages that should never be treated as an article. */
const NON_ARTICLE_HOST_PATTERNS = Object.freeze([
  /(^|\.)(google|bing|duckduckgo|yandex)\.[a-z.]{2,}$/i,
  /(^|\.)(chrome|edge|about|chrome-extension)$/i,
  /(^|\.)(localhost)$/i,
]);

const PAGE_TYPE = Object.freeze({
  PRODUCT: 'product',
  ARTICLE: 'article',
  UNSUPPORTED: 'unsupported',
});

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

const els = {
  states: {
    loading: document.getElementById('state-loading'),
    product: document.getElementById('state-product'),
    article: document.getElementById('state-article'),
    unsupported: document.getElementById('state-unsupported'),
    thinking: document.getElementById('state-thinking'),
    result: document.getElementById('state-result'),
    error: document.getElementById('state-error'),
    'ai-off': document.getElementById('state-ai-off'),
  },
  unsupportedUrl: document.getElementById('unsupported-url'),
  btnProduct: document.getElementById('btn-product'),
  btnArticle: document.getElementById('btn-article'),
  creditsLeft: document.getElementById('credits-left'),
  creditsTotal: document.getElementById('credits-total'),
  creditsDot: document.getElementById('credits-dot'),
  creditsBar: document.getElementById('credits-bar'),
  creditsFill: document.getElementById('credits-fill'),
  // Phase 3 (AI)
  thinkingSub: document.getElementById('thinking-sub'),
  resultEyebrow: document.getElementById('result-eyebrow'),
  resultBox: document.getElementById('result-box'),
  resultText: document.getElementById('result-text'),
  btnCopy: document.getElementById('btn-copy'),
  btnAgain: document.getElementById('btn-again'),
  errorText: document.getElementById('error-text'),
  btnRetry: document.getElementById('btn-retry'),
  aiStatus: document.getElementById('ai-status'),
  btnOpenFlags: document.getElementById('btn-open-flags'),
  btnAiRecheck: document.getElementById('btn-ai-recheck'),
  aiCopyHint: document.getElementById('ai-copy-hint'),
};

/** Where the user enables the built-in model. */
const AI_FLAGS_URL = 'chrome://flags/#prompt-api-for-gemini-nano';

/* ------------------------------------------------------------------ */
/* Page-type detection                                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {string|undefined} url
 * @returns {'product'|'article'|'unsupported'}
 */
function detectPageType(url) {
  let parsed;
  try {
    parsed = new URL(url ?? '');
  } catch {
    return PAGE_TYPE.UNSUPPORTED;
  }

  // chrome://, chrome-extension://, edge://, about:, file:, view-source:, data: ...
  if (!/^https?:$/.test(parsed.protocol)) return PAGE_TYPE.UNSUPPORTED;

  const host = parsed.hostname;

  if (PRODUCT_HOST_PATTERNS.some((re) => re.test(host))) return PAGE_TYPE.PRODUCT;
  if (VIDEO_HOST_PATTERNS.some((re) => re.test(host))) return PAGE_TYPE.ARTICLE;
  if (NON_ARTICLE_HOST_PATTERNS.some((re) => re.test(host))) return PAGE_TYPE.UNSUPPORTED;

  // Any other web page with a real path (e.g. example.com/some-article)
  const hasPath = parsed.pathname.replace(/\//g, '').length > 0;
  if (hasPath) return PAGE_TYPE.ARTICLE;

  // Home pages (example.com/) — not something we can summarise yet.
  return PAGE_TYPE.UNSUPPORTED;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** @param {'loading'|'product'|'article'|'unsupported'|'thinking'|'result'|'error'|'ai-off'} name */
function showState(name) {
  for (const [key, node] of Object.entries(els.states)) {
    node.hidden = key !== name;
  }
  // Only the page-type CTAs live in the top states; always hand them back
  // enabled/labelled so a cancelled run never leaves a dead button behind.
  for (const [btn, label] of [
    [els.btnProduct, PRODUCT_CTA_LABEL],
    [els.btnArticle, ARTICLE_CTA_LABEL],
  ]) {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * @param {'product'|'article'|'unsupported'} pageType
 * @param {string} [url]
 */
function renderPageType(pageType, url) {
  switch (pageType) {
    case PAGE_TYPE.PRODUCT:
      showState('product');
      break;
    case PAGE_TYPE.ARTICLE:
      showState('article');
      break;
    default:
      if (url) {
        els.unsupportedUrl.textContent = shortenUrl(url);
        els.unsupportedUrl.hidden = false;
      } else {
        els.unsupportedUrl.hidden = true;
      }
      showState('unsupported');
  }
}

/** @param {string} url */
function shortenUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.length > 28 ? `${pathname.slice(0, 28)}…` : pathname;
    return hostname + path;
  } catch {
    return url;
  }
}

/**
 * @param {number} left
 * @param {number} total
 */
function renderCredits(left, total) {
  const safeTotal = total > 0 ? total : DAILY_FREE_CREDITS;
  const safeLeft = Math.min(Math.max(0, left), safeTotal);
  const isEmpty = safeLeft === 0;

  els.creditsLeft.textContent = String(safeLeft);
  els.creditsTotal.textContent = String(safeTotal);
  els.creditsBar.setAttribute('aria-valuemax', String(safeTotal));
  els.creditsBar.setAttribute('aria-valuenow', String(safeLeft));

  els.creditsFill.style.width = `${(safeLeft / safeTotal) * 100}%`;
  els.creditsFill.classList.toggle('is-empty', isEmpty);
  els.creditsDot.classList.toggle('is-empty', isEmpty);
  els.creditsDot.hidden = !isEmpty;
}

/* ------------------------------------------------------------------ */
/* Credits (chrome.storage.sync)                                       */
/* ------------------------------------------------------------------ */

/** Local calendar day, e.g. "2026-10-19". */
function todayKey() {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Reads the stored counter and resets it once per calendar day.
 * @returns {Promise<{left: number, total: number}>}
 */
function loadCredits() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      [STORAGE_KEYS.CREDITS_LEFT, STORAGE_KEYS.CREDITS_DATE, STORAGE_KEYS.CREDITS_TOTAL],
      (data) => {
        if (chrome.runtime.lastError) {
          // Storage unavailable → show the default balance, never crash the UI.
          console.warn('[El Zatoona] storage read failed:', chrome.runtime.lastError.message);
          resolve({ left: DAILY_FREE_CREDITS, total: DAILY_FREE_CREDITS });
          return;
        }

        const total =
          Number.isInteger(data[STORAGE_KEYS.CREDITS_TOTAL]) && data[STORAGE_KEYS.CREDITS_TOTAL] > 0
            ? data[STORAGE_KEYS.CREDITS_TOTAL]
            : DAILY_FREE_CREDITS;

        const today = todayKey();
        const sameDay = data[STORAGE_KEYS.CREDITS_DATE] === today;
        const stored = data[STORAGE_KEYS.CREDITS_LEFT];

        if (sameDay && Number.isFinite(stored)) {
          resolve({ left: stored, total });
          return;
        }

        // New day (or first run): refill.
        chrome.storage.sync.set(
          {
            [STORAGE_KEYS.CREDITS_LEFT]: total,
            [STORAGE_KEYS.CREDITS_DATE]: today,
            [STORAGE_KEYS.CREDITS_TOTAL]: total,
          },
          () => resolve({ left: total, total }),
        );
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Active tab                                                          */
/* ------------------------------------------------------------------ */

/**
 * Returns the active tab of the window the user was on BEFORE the popup opened.
 *
 * Important: `currentWindow: true` would resolve to the popup's own window once
 * the popup has focus (Chrome docs: "the current window is the window that
 * contains the page making the call"), which would make every page look
 * unsupported. So we ask for the active tab of the last-focused window
 * (verified: it resolves to the page the user was on, never the popup).
 *
 * With the `activeTab` permission the URL is only readable for the tab the
 * toolbar icon was clicked on; any other tab returns no url, which the UI
 * renders as the neutral "not supported here yet" state.
 *
 * @returns {Promise<{id: number, url: string, title: string}|null>}
 */
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn('[El Zatoona] tabs.query failed:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      const active = (Array.isArray(tabs) ? tabs : []).find((t) => typeof t.url === 'string' && t.url);
      resolve(active ? { id: active.id, url: active.url ?? '', title: active.title ?? '' } : null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Extraction — chrome.scripting.executeScript (Phase 2)               */
/* ------------------------------------------------------------------ */

/**
 * The extractor lives in its own file. Loading it with a <script> tag gives
 * us `extractContent` as a normal function, which `executeScript({func})`
 * can serialise and run inside the page.
 *
 * @param {number} tabId
 * @param {'product'|'article'} type
 */
async function extractFromTab(tabId, type) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractContent, // eslint-disable-line no-undef
    args: [type],
  });
  return injection ? injection.result : null;
}

/**
 * Click handler. Returns early (and pays no AI cost) when the built-in model
 * is not enabled, so a user without Gemini Nano never sees a spinner or a
 * timeout — just the "how to enable it" screen.
 *
 * @param {'product'|'article'} type
 */
async function handleCtaClick(type) {
  const button = type === PAGE_TYPE.PRODUCT ? els.btnProduct : els.btnArticle;

  button.disabled = true;
  button.textContent = 'بنجهّز الذكاء الاصطناعي…';

  try {
    const ai = await ZatoonaAI.check(); // eslint-disable-line no-undef
    if (!ai.supported) {
      currentJob = null;
      showAiOff(ai.status);
      return;
    }
  } catch (err) {
    console.error('[El Zatoona] AI check failed:', err);
    showErr('مقدرناش نتأكد من الذكاء الاصطناعي في المتصفح. جرّب تاني.');
    return;
  } finally {
    button.disabled = false;
    button.textContent = type === PAGE_TYPE.PRODUCT ? PRODUCT_CTA_LABEL : ARTICLE_CTA_LABEL;
  }

  if (!activeTab || typeof activeTab.id !== 'number') {
    showErr('التاب مش متاح — اقفل الإضافة وجرب تاني.');
    return;
  }

  showState('thinking');
  els.thinkingSub.textContent = 'بنسحب محتوى الصفحة…';

  // Remember what to re-run for "جرّب تاني".
  currentJob = { type, tabId: activeTab.id };
  runJob(currentJob);
}

/** @param {{type: 'product'|'article', tabId: number}} job */
async function runJob(job) {
  const { type, tabId } = job;

  try {
    // 1) Page → text (Phase 2 extractor, unchanged).
    const result = await extractFromTab(tabId, type);
    if (!result) throw new Error('السكربت رجع من غير نتيجة.');
    if (result.error) throw new Error(`حصل خطأ في السحب: ${result.error}`);

    const pageText = String(result.text || '').trim();
    if (pageText.length < 40) {
      throw new Error('لقينا محتوى قليل جداً في الصفحة — افتح الصفحة كاملة وجرّب تاني.');
    }

    // 2) Text + prompt → Gemini Nano.
    els.thinkingSub.textContent = 'بنسأل الذكاء الاصطناعي…';

    // Full payload stays in the console for debugging (no UI clutter).
    console.groupCollapsed('[El Zatoona] extracted');
    console.log('type:', type, 'chars:', pageText.length);
    console.log(result);
    console.groupEnd();

    const answer = await ZatoonaAI.generate(ZatoonaAI.buildPrompt(type, pageText), { // eslint-disable-line no-undef
      onDownload: (loaded, total) => {
        const pct = total ? ` (${Math.round((loaded / total) * 100)}%)` : '';
        els.thinkingSub.textContent = `بنحمّل موديل الذكاء الاصطناعي أول مرة، ممكن ياخد شوية…${pct}`;
      },
    });

    if (!answer) throw new Error('الذكاء الاصطناعي رجع رد فاضي — جرّب تاني.');

    showResult(type, answer);
  } catch (err) {
    console.error('[El Zatoona] AI flow failed:', err);
    const message = String((err && err.message) || err);

    // Chrome throws these when the prompt API is enabled but the model is not
    // usable yet (not downloaded, GPU-less machine, unsupported locale…).
    if (
      (err && err.code === 'AI_UNSUPPORTED') ||
      /AI_UNSUPPORTED|NotSupportedError|not available|not supported/i.test(message)
    ) {
      showAiOff('unavailable');
    } else if (/failed to fetch|network|connection|offline/i.test(message)) {
      showAiOff('downloadable');
    } else if (/context|too (large|long)|input.+exceed/i.test(message)) {
      showErr('المحتوى أطول من اللي الموديل بيستوعبه. جرّب على صفحة أقصر.');
    } else {
      showErr('مقدرناش نكمل الطلب. تأكد إن الذكاء الاصطناعي مفعّل وجرّب تاني.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering the AI result                                             */
/* ------------------------------------------------------------------ */

/** @param {'product'|'article'} type @param {string} answer */
function showResult(type, answer) {
  els.resultEyebrow.textContent = type === PAGE_TYPE.PRODUCT ? '🌿 زتونة المنتج' : '🌿 زتونة المقال';
  els.resultText.textContent = answer;

  // Long answers scroll inside the box instead of stretching the popup.
  els.resultBox.scrollTop = 0;
  showState('result');
}

/** @param {string} message */
function showErr(message) {
  els.errorText.textContent = message;
  showState('error');
}

/**
 * The "enable AI in your browser" screen.
 * @param {string} [status] value from ZatoonaAI.check()
 */
function showAiOff(status) {
  const notes = {
    downloadable: 'موديل Gemini Nano متاح على جهازك لكنه لسه مش متحمّل — كروم هينزّله أول مرة لوحده، اقفل النافذة وجرب تاني بعد شوية.',
    unavailable: 'كروم مش لاقي الموديل خالص. اتأكد من الخطوات اللي تحت، ولو لسه مش شغال جرّب تحدّث كروم.',
    downloading: 'موديل Gemini Nano بيتحمّل دلوقتي. استنى شوية وقفل النافذة وافتحها تاني.',
  };

  const note = notes[status] || '';
  els.aiStatus.textContent = note;
  els.aiStatus.hidden = !note;
  els.aiCopyHint.hidden = true;
  showState('ai-off');
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

els.btnProduct.addEventListener('click', () => handleCtaClick(PAGE_TYPE.PRODUCT));
els.btnArticle.addEventListener('click', () => handleCtaClick(PAGE_TYPE.ARTICLE));

els.btnRetry.addEventListener('click', () => {
  if (currentJob) runJob(currentJob);
  else renderPageType(detectPageType(activeTab && activeTab.url), activeTab && activeTab.url);
});

els.btnAgain.addEventListener('click', () => {
  if (currentJob) runJob(currentJob);
  else if (activeTab && activeTab.url) renderPageType(detectPageType(activeTab.url), activeTab.url);
});

/**
 * The extension itself can open chrome:// pages (a normal link cannot).
 * In the QA harness there is no chrome.tabs.create, hence the copy fallback.
 */
els.btnOpenFlags.addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: AI_FLAGS_URL });
    window.close(); // popups close themselves once the tab opens
  } catch {
    try {
      await navigator.clipboard.writeText(AI_FLAGS_URL);
    } catch {
      /* the text is on screen anyway, the user can type/select it */
    }
    els.aiCopyHint.textContent = 'اتنسخ اللينك — الصقه في شريط العناوين في تاب جديد. ⬅';
    els.aiCopyHint.hidden = false;
  }
});

/** Re-runs the check after the user enabled the model (no chrome restart needed to retry). */
els.btnAiRecheck.addEventListener('click', () => {
  if (currentJob) runJob(currentJob);
  else if (activeTab && activeTab.url) renderPageType(detectPageType(activeTab.url), activeTab.url);
});

els.btnCopy.addEventListener('click', async () => {
  const label = els.btnCopy.textContent;
  try {
    await navigator.clipboard.writeText(els.resultText.textContent || '');
    els.btnCopy.textContent = '✓ اتنسخت';
  } catch {
    // Clipboard is sometimes blocked inside popups: select the text instead.
    const range = document.createRange();
    range.selectNodeContents(els.resultText);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    els.btnCopy.textContent = 'اضغط Ctrl+C';
  }
  setTimeout(() => {
    els.btnCopy.textContent = label;
  }, 1600);
});

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

/** @type {{id?: number, url: string, title: string}|null} */
let activeTab = null;

/** Last click, kept so "جرّب تاني" can repeat it. @type {{type: 'product'|'article', tabId: number}|null} */
let currentJob = null;

async function init() {
  showState('loading');

  const [tab, credits] = await Promise.all([getActiveTab(), loadCredits()]);

  renderCredits(credits.left, credits.total);

  // No URL → the page is not accessible (chrome://, Web Store, or activeTab
  // access not granted). We cannot say what it is, so keep the neutral
  // "not supported" message without echoing a URL.
  if (!tab || !tab.url) {
    renderPageType(PAGE_TYPE.UNSUPPORTED);
    return;
  }

  activeTab = tab;
  renderPageType(detectPageType(tab.url), tab.url);
}

// popup.js is loaded at the end of <body>, so the DOM is already parsed.
// Run immediately instead of waiting for DOMContentLoaded (which may have fired).
init();
