/**
 * El Zatoona — Popup (Phase 4: cloud AI + credits + Pro)
 * ---------------------------------------------------------------
 * • Detects the current tab (activeTab) and renders the matching state.
 * • Free plan: 5 attempts per calendar day, stored in chrome.storage.sync.
 *   Pro plan : `isPro: true` in chrome.storage.sync → no credit is spent.
 * • On CTA click:
 *     1. Free user with 0 attempts → paywall, no extraction and no API call;
 *     2. injects `extractContent()` (src/content/extract.js) into the tab;
 *     3. sends the extracted text to our Vercel endpoint (src/ai/ai.js);
 *     4. only AFTER a successful answer, one attempt is deducted.
 * • Paywall → Gumroad checkout + licence-key activation (src/ai/pro.js).
 *
 * NOTE: `vercel-backend/` holds the serverless API and the Gemini keys.
 * Nothing secret lives inside the extension.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const DAILY_FREE_CREDITS = 5;

/** CTA labels (also used to reset the button after a cancelled run). */
const PRODUCT_CTA_LABEL = '🌿 إديني زتونة المنتج';
const ARTICLE_CTA_LABEL = '🌿 لخصلّي الزتونة';

/**
 * Gumroad — where "اشترك الآن" goes. The product id / permalink used by the
 * licence check live in manifest.json → `gumroad` (src/ai/pro.js reads them).
 * Keep the two in sync if the product changes.
 */
const GUMROAD_CHECKOUT_URL = 'https://elzatoona.gumroad.com/l/el-zatoona';

/** Storage keys (chrome.storage.sync) */
const STORAGE_KEYS = Object.freeze({
  CREDITS_LEFT: 'creditsLeft',
  CREDITS_DATE: 'creditsDate',
  CREDITS_TOTAL: 'creditsTotal',
  IS_PRO: 'isPro',
  LICENSE_KEY: 'licenseKey',
  PRO_SALE: 'proSale',
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

const byId = (id) => document.getElementById(id);

const els = {
  states: {
    loading: byId('state-loading'),
    product: byId('state-product'),
    article: byId('state-article'),
    unsupported: byId('state-unsupported'),
    thinking: byId('state-thinking'),
    result: byId('state-result'),
    error: byId('state-error'),
    paywall: byId('state-paywall'),
  },
  unsupportedUrl: byId('unsupported-url'),
  btnProduct: byId('btn-product'),
  btnArticle: byId('btn-article'),
  proBadge: byId('pro-badge'),
  creditsFree: byId('credits-free'),
  creditsPro: byId('credits-pro'),
  creditsLeft: byId('credits-left'),
  creditsTotal: byId('credits-total'),
  creditsDot: byId('credits-dot'),
  creditsBar: byId('credits-bar'),
  creditsFill: byId('credits-fill'),
  btnManagePro: byId('btn-manage-pro'),
  thinkingSub: byId('thinking-sub'),
  resultEyebrow: byId('result-eyebrow'),
  resultBox: byId('result-box'),
  resultText: byId('result-text'),
  btnCopy: byId('btn-copy'),
  btnAgain: byId('btn-again'),
  errorText: byId('error-text'),
  btnRetry: byId('btn-retry'),
  btnSubscribe: byId('btn-subscribe'),
  btnShowLicense: byId('btn-show-license'),
  licenseForm: byId('license-form'),
  licenseInput: byId('license-input'),
  licenseStatus: byId('license-status'),
  btnActivate: byId('btn-activate'),
};

/** Shared UI state. */
const state = {
  isPro: false,
  credits: { left: DAILY_FREE_CREDITS, total: DAILY_FREE_CREDITS },
};

/** @type {{id?: number, url: string, title: string}|null} */
let activeTab = null;

/** Last run, kept so "جرّب تاني" can repeat it. @type {{type: 'product'|'article', tabId: number}|null} */
let currentJob = null;

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

/** @param {'loading'|'product'|'article'|'unsupported'|'thinking'|'result'|'error'|'paywall'} name */
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
    const path = pathname.length > 48 ? `${pathname.slice(0, 48)}…` : pathname;
    return hostname + path;
  } catch {
    return url;
  }
}

/**
 * Footer + header for the current plan.
 * Free → "متبقي x/5" + progress bar. Pro → "بدون حدود", no bar.
 *
 * @param {{left: number, total: number}} credits
 * @param {boolean} isPro
 */
function renderCredits(credits, isPro) {
  const safeTotal = credits.total > 0 ? credits.total : DAILY_FREE_CREDITS;
  const safeLeft = Math.min(Math.max(0, credits.left), safeTotal);
  const isEmpty = safeLeft === 0;

  els.proBadge.hidden = !isPro;
  els.btnManagePro.hidden = !isPro;
  els.creditsFree.hidden = isPro;
  els.creditsPro.hidden = !isPro;
  els.creditsBar.hidden = isPro;
  els.creditsDot.hidden = isPro;

  els.creditsLeft.textContent = String(safeLeft);
  els.creditsTotal.textContent = String(safeTotal);
  els.creditsBar.setAttribute('aria-valuemax', String(safeTotal));
  els.creditsBar.setAttribute('aria-valuenow', String(safeLeft));

  els.creditsFill.style.width = `${(safeLeft / safeTotal) * 100}%`;
  els.creditsFill.classList.toggle('is-empty', isEmpty);
  els.creditsDot.classList.toggle('is-empty', isEmpty);
}

/* ------------------------------------------------------------------ */
/* Storage (chrome.storage.sync)                                       */
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

/**
 * Persists one used attempt and mirrors it in the UI.
 * @returns {Promise<{left: number, total: number}>}
 */
async function spendCredit() {
  const { left, total } = await loadCredits();
  const next = Math.max(0, left - 1);

  await new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        [STORAGE_KEYS.CREDITS_LEFT]: next,
        [STORAGE_KEYS.CREDITS_DATE]: todayKey(),
        [STORAGE_KEYS.CREDITS_TOTAL]: total,
      },
      () => resolve(),
    );
  });

  state.credits = { left: next, total };
  renderCredits(state.credits, state.isPro);
  return state.credits;
}

/** @returns {Promise<{isPro: boolean}>} */
function loadLicense() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEYS.IS_PRO], (data) => {
      resolve({ isPro: !chrome.runtime.lastError && data[STORAGE_KEYS.IS_PRO] === true });
    });
  });
}

/** @param {boolean} isPro @param {{licenseKey?: string, sale?: object}} [extra] */
function saveLicense(isPro, extra = {}) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        [STORAGE_KEYS.IS_PRO]: isPro,
        [STORAGE_KEYS.LICENSE_KEY]: extra.licenseKey || '',
        [STORAGE_KEYS.PRO_SALE]: extra.sale || null,
      },
      () => resolve(),
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

/** Opens a URL in a new tab (falls back to window.open in the QA harness). */
async function openTab(url) {
  try {
    if (chrome.tabs && typeof chrome.tabs.create === 'function') {
      await chrome.tabs.create({ url });
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, '_blank', 'noopener');
}

/* ------------------------------------------------------------------ */
/* Extraction — chrome.scripting.executeScript                         */
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

/* ------------------------------------------------------------------ */
/* The main flow                                                       */
/* ------------------------------------------------------------------ */

/**
 * Click handler.
 * - Free user with 0 attempts → paywall, no extraction, no API call.
 * - Otherwise → spinner, then runJob().
 *
 * @param {'product'|'article'} type
 */
async function handleCtaClick(type) {
  if (!state.isPro) {
    const credits = await loadCredits();
    state.credits = credits;
    renderCredits(credits, false);
    if (credits.left <= 0) {
      showPaywall();
      return;
    }
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

  showState('thinking');
  els.thinkingSub.textContent = 'بنسحب محتوى الصفحة…';

  try {
    // 1) Page → text (Phase 2 extractor).
    const result = await extractFromTab(tabId, type);
    if (!result) throw new Error('السكربت رجع من غير نتيجة.');
    if (result.error) throw new Error(`حصل خطأ في السحب: ${result.error}`);

    const pageText = String(result.text || '').trim();
    if (pageText.length < 40) {
      throw new Error('لقينا محتوى قليل جداً في الصفحة — افتح الصفحة كاملة وجرّب تاني.');
    }

    // Full payload stays in the console for debugging (no UI clutter).
    console.groupCollapsed('[El Zatoona] extracted');
    console.log('type:', type, 'chars:', pageText.length, 'pro:', state.isPro);
    console.log(result);
    console.groupEnd();

    // 2) Text → Vercel API → Gemini.
    els.thinkingSub.textContent = 'بنسأل الزتونة…';
    const answer = await ZatoonaAI.summarize({ // eslint-disable-line no-undef
      type,
      text: ZatoonaAI.buildPrompt(type, pageText), // eslint-disable-line no-undef
      title: result.title,
    });

    // 3) Only a successful answer costs an attempt (Pro users: never).
    if (!state.isPro) await spendCredit();

    showResult(type, answer);
  } catch (err) {
    console.error('[El Zatoona] flow failed:', err);
    const status = err && err.status;
    const AI = ZatoonaAI.STATUS; // eslint-disable-line no-undef

    if (status === AI.OUT_OF_QUOTA) {
      showErr('خدمة التلخيص عليها ضغط دلوقتي. جرّب تاني بعد دقيقة.');
    } else if (status === AI.OFFLINE) {
      showErr('مش قادرين نوصل للسيرفر — اتأكد من الإنترنت وجرّب تاني.');
    } else if (status === AI.TIMEOUT) {
      showErr('الطلب خد وقت أطول من اللازم. جرّب تاني.');
    } else if (/محتوى قليل|السكربت|حصل خطأ في السحب/.test(String(err && err.message))) {
      showErr(String(err.message));
    } else {
      showErr('مقدرناش نكمل الطلب. جرّب تاني بعد شوية.');
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

/** The "free attempts are over" screen. */
function showPaywall() {
  els.licenseForm.hidden = true;
  els.licenseStatus.hidden = true;
  els.licenseInput.value = '';
  showState('paywall');
}

/* ------------------------------------------------------------------ */
/* Paywall: Gumroad checkout + licence activation                      */
/* ------------------------------------------------------------------ */

const LICENSE_MESSAGES = {
  valid: 'تم التفعيل! نسختك الـ Pro شغالة دلوقتي — استمتع بالتلخيص بدون حدود. ✨',
  invalid: 'الكود مش صح أو مش تابع للزتونة. اتأكد منه وجرب تاني.',
  refunded: 'الاشتراك ده ملغي أو اتعمله استرجاع، فمش متاح تفعيله.',
  not_configured: 'التحقق من الأكواد مش متفعّل لسه — كلم الدعم.',
  network: 'مش قادرين نتحقق من الكود دلوقتي. اتأكد من الإنترنت وجرب تاني.',
};

/**
 * @param {string} message
 * @param {'ok'|'error'|'info'} kind
 */
function showLicenseStatus(message, kind) {
  els.licenseStatus.textContent = message;
  els.licenseStatus.classList.toggle('is-ok', kind === 'ok');
  els.licenseStatus.classList.toggle('is-error', kind === 'error');
  els.licenseStatus.hidden = false;
}

/** @param {SubmitEvent} event */
async function activateLicense(event) {
  event.preventDefault();

  const key = els.licenseInput.value.trim();
  if (!key) {
    showLicenseStatus('اكتب كود التفعيل الأول.', 'error');
    els.licenseInput.focus();
    return;
  }

  els.btnActivate.disabled = true;
  els.btnActivate.textContent = 'بنفعّل…';
  showLicenseStatus('بنتحقق من الكود مع Gumroad…', 'info');

  const PRO = ZatoonaPro; // eslint-disable-line no-undef

  try {
    const result = await PRO.verify(key);

    if (result.status === PRO.STATUS.VALID) {
      await saveLicense(true, { licenseKey: key, sale: result.sale });
      state.isPro = true;
      renderCredits(state.credits, true);
      showLicenseStatus(LICENSE_MESSAGES.valid, 'ok');
      // Let the success message be read, then hand the page CTA back.
      setTimeout(() => {
        if (currentJob) runJob(currentJob);
        else if (activeTab && activeTab.url) renderPageType(detectPageType(activeTab.url), activeTab.url);
      }, 900);
      return;
    }

    showLicenseStatus(LICENSE_MESSAGES[result.status] || LICENSE_MESSAGES.invalid, 'error');
  } catch (err) {
    console.error('[El Zatoona] licence check failed:', err);
    showLicenseStatus(LICENSE_MESSAGES.network, 'error');
  } finally {
    els.btnActivate.disabled = false;
    els.btnActivate.textContent = 'تفعيل';
  }
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

els.btnSubscribe.addEventListener('click', () => {
  openTab(GUMROAD_CHECKOUT_URL);
});

els.btnManagePro.addEventListener('click', () => {
  openTab(GUMROAD_CHECKOUT_URL);
});

els.btnShowLicense.addEventListener('click', () => {
  els.licenseForm.hidden = !els.licenseForm.hidden;
  if (!els.licenseForm.hidden) els.licenseInput.focus();
});

els.licenseForm.addEventListener('submit', activateLicense);

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

async function init() {
  showState('loading');

  const [tab, credits, license] = await Promise.all([getActiveTab(), loadCredits(), loadLicense()]);

  // QA hooks (no effect in production): preset the plan / balance or open a
  // specific screen (`?state=paywall`) to check the UI without a real account.
  if (globalThis.ZATOONA_QA) {
    const qa = globalThis.ZATOONA_QA;
    if (typeof qa.creditsLeft === 'number') credits.left = qa.creditsLeft;
    if (typeof qa.isPro === 'boolean') license.isPro = qa.isPro;
    if (qa.loading) {
      showState('loading');
      return;
    }
    if (qa.state === 'paywall') showPaywall();
    if (qa.state === 'thinking') showState('thinking');
  }

  state.credits = credits;
  state.isPro = license.isPro;
  renderCredits(credits, state.isPro);

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
