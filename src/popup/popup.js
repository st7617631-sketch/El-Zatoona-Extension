/**
 * El Zatoona — Popup (Phase 2: Data Extraction)
 * ---------------------------------------------------------------
 * • Detects the current tab (activeTab) and renders one of 3 states.
 * • Shows the daily free-credits counter, stored ONLY in
 *   chrome.storage.sync (no server, no external API).
 * • On CTA click: injects `extractContent()` (src/content/extract.js) into the
 *   active tab with chrome.scripting.executeScript and shows the raw result in
 *   a textarea + console for testing. NO AI yet — that is Phase 3.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DAILY_FREE_CREDITS = 5;

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
  },
  unsupportedUrl: document.getElementById('unsupported-url'),
  btnProduct: document.getElementById('btn-product'),
  btnArticle: document.getElementById('btn-article'),
  creditsLeft: document.getElementById('credits-left'),
  creditsTotal: document.getElementById('credits-total'),
  creditsDot: document.getElementById('credits-dot'),
  creditsBar: document.getElementById('credits-bar'),
  creditsFill: document.getElementById('credits-fill'),
  // Phase 2 (temporary test UI)
  extractPanel: document.getElementById('extract-panel'),
  extractOutput: document.getElementById('extract-output'),
  extractArabic: document.getElementById('extract-arabic'),
  extractMeta: document.getElementById('extract-meta'),
  extractStatus: document.getElementById('extract-status'),
  btnCopy: document.getElementById('btn-copy'),
  btnCloseExtract: document.getElementById('btn-close-extract'),
};

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

/** @param {'loading'|'product'|'article'|'unsupported'} name */
function showState(name) {
  for (const [key, node] of Object.entries(els.states)) {
    node.hidden = key !== name;
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

/** Renders the extracted payload in the temporary test panel. */
function showExtracted(result, type) {
  const data = result && (result.data || {});
  const stats = (result && result.stats) || {};
  const isProduct = type === PAGE_TYPE.PRODUCT;

  const label = isProduct ? 'منتج' : 'مقال';
  const meta = [
    (result && result.site) || '',
    `${stats.chars ?? 0} حرف`,
    isProduct ? `${stats.features ?? 0} وصف / ${stats.reviews ?? 0} تقييم` : `${stats.paragraphs ?? 0} فقرة`,
  ]
    .filter(Boolean)
    .join(' · ');

  els.extractMeta.textContent = meta;

  // The payload mixes Arabic labels with English site content. Putting it all
  // in one RTL box scrambles mixed lines, so it is shown as two boxes: the
  // extracted text (kept LTR) and the Arabic labels around it.
  const rawText = (result && result.text) || 'مفيش داتا اتسحبت.';
  const arabicLines = rawText.split('\n').filter((line) => /[\u0600-\u06FF]/.test(line));
  const contentLines = rawText.split('\n').filter((line) => !/[\u0600-\u06FF]/.test(line));

  els.extractArabic.value = arabicLines.join('\n').trim();
  els.extractArabic.hidden = !els.extractArabic.value;
  els.extractOutput.value = contentLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || 'مفيش داتا اتسحبت.';
  els.extractOutput.dataset.fullText = rawText;
  els.extractPanel.hidden = false;

  setStatus(
    result && result.error
      ? `حصل خطأ في السحب: ${result.error}`
      : `✓ اتسحبت داتا ${label}` + (data.source ? ` (${data.source})` : ''),
    Boolean(result && result.error),
  );

  // Full structured payload for inspection (View → Developer → Inspect popup).
  console.group('[El Zatoona] extracted');
  console.log('type:', type);
  console.log('data:', result);
  console.log('text:', (result && result.text) || '');
  console.groupEnd();
}

/** @param {string} message @param {boolean} isError */
function setStatus(message, isError = false) {
  els.extractStatus.textContent = message;
  els.extractStatus.classList.toggle('is-error', isError);
  els.extractStatus.hidden = !message;
}

/** @param {'product'|'article'} type */
async function handleCtaClick(type) {
  const button = type === PAGE_TYPE.PRODUCT ? els.btnProduct : els.btnArticle;
  const originalLabel = button.textContent;

  button.disabled = true;
  button.textContent = 'بنسحب الداتا…';
  setStatus('بنسحب محتوى الصفحة…');

  try {
    const tabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : -1;

    if (tabId < 0) {
      throw new Error('التاب مش متاح — اقفل وجرب تاني أو اعمل Refresh للصفحة.');
    }

    const result = await extractFromTab(tabId, type);
    if (!result) throw new Error('السكربت رجع من غير نتيجة.');

    showExtracted(result, type);
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error('[El Zatoona] extraction failed:', err);
    els.extractPanel.hidden = true;
    setStatus(`مقدرناش نسحب من الصفحة: ${message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

els.btnProduct.addEventListener('click', () => handleCtaClick(PAGE_TYPE.PRODUCT));
els.btnArticle.addEventListener('click', () => handleCtaClick(PAGE_TYPE.ARTICLE));

els.btnCloseExtract.addEventListener('click', () => {
  els.extractPanel.hidden = true;
  setStatus('');
});

els.btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.extractOutput.dataset.fullText || els.extractOutput.value);
    setStatus('✓ اتنسخت');
  } catch {
    els.extractOutput.select();
    setStatus('اختار وانسخ بـ Ctrl+C');
  }
});

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

/** @type {{id?: number, url: string, title: string}|null} */
let activeTab = null;

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
