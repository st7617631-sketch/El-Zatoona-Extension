/**
 * El Zatoona — Popup (Phase 1: Setup & UI)
 * ---------------------------------------------------------------
 * • Detects the current tab (activeTab) and renders one of 3 states.
 * • Shows the daily free-credits counter, stored ONLY in
 *   chrome.storage.sync (no server, no external API).
 *
 * Phase 1 is UI-only: the two CTA buttons are wired but intentionally
 * do nothing yet (Phase 2 adds the window.ai logic + credit spending).
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
 * Product pages: Amazon (all locales) + Noon (all locales).
 * Matches root/path domains like amazon.com, amazon.eg, amazon.co.uk, noon.com, noon.ae ...
 */
const PRODUCT_HOST_PATTERNS = Object.freeze([
  /(^|\.)amazon\.[a-z.]{2,}$/i,
  /(^|\.)noon\.[a-z.]{2,}$/i,
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
 * @returns {Promise<{url: string, title: string}|null>}
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
      resolve(active ? { url: active.url ?? '', title: active.title ?? '' } : null);
    });
  });
}

/* ------------------------------------------------------------------ */
/* Buttons (CTA) — Phase 1: wired, logic comes in Phase 2              */
/* ------------------------------------------------------------------ */

/** @param {'product'|'article'} type */
function handleCtaClick(type) {
  // Phase 2 will call window.ai + spend a credit here.
  console.info(`[El Zatoona] CTA "${type}" clicked (Phase 1: no AI yet).`);
}

els.btnProduct.addEventListener('click', () => handleCtaClick(PAGE_TYPE.PRODUCT));
els.btnArticle.addEventListener('click', () => handleCtaClick(PAGE_TYPE.ARTICLE));

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

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

  renderPageType(detectPageType(tab.url), tab.url);
}

// popup.js is loaded at the end of <body>, so the DOM is already parsed.
// Run immediately instead of waiting for DOMContentLoaded (which may have fired).
init();
