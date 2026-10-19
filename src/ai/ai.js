/**
 * El Zatoona — Built-in AI (Phase 3)
 * ---------------------------------------------------------------
 * Everything AI-related lives here: feature detection (is Gemini Nano ready?),
 * prompt building, and one function that turns extracted page text into the
 * final Arabic answer.
 *
 * It talks ONLY to the browser's built-in model — no server, no API key:
 *   1. Current API:  window.LanguageModel   (Chrome 138+, formerly `window.ai.languageModel`)
 *   2. Legacy API:   window.ai.languageModel (Chrome 128–137)
 *
 * Loaded in popup.html BEFORE popup.js, so it exposes a single global:
 * `ZatoonaAI`.
 *
 * The file is also loaded by the QA scripts (.qa/ai-flow.mjs), so it must not
 * touch `document` or any other DOM node at load time.
 */

'use strict';

/* eslint-disable no-var */
var ZatoonaAI = (function () {
  /** Set `window.ZATOONA_DEBUG = true` in the popup console for status logs. */
  const DEBUG = Boolean(globalThis.ZATOONA_DEBUG);

  /** Statuses returned by the browser for the *prompt* API. */
  const STATUS = Object.freeze({
    AVAILABLE: 'available',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    UNAVAILABLE: 'unavailable',
  });

  /**
   * Chromium has used both vocabularies: the prompt API says "available" and
   * the older summarizer-style API said "readily"; "after-download" and
   * "downloadable" both mean the model is known but not on disk yet.
   */
  const normalize = (raw) => {
    const s = String(raw || '').toLowerCase();
    if (s === 'available' || s === 'readily') return STATUS.AVAILABLE;
    if (s === 'after-download' || s === 'downloadable') return STATUS.DOWNLOADABLE;
    if (s === 'downloading') return STATUS.DOWNLOADING;
    return STATUS.UNAVAILABLE;
  };

  /** The prompt API in whichever shape this Chrome exposes it. */
  function getApi() {
    if (globalThis.LanguageModel) return globalThis.LanguageModel;
    if (globalThis.ai && globalThis.ai.languageModel) return globalThis.ai.languageModel;
    return null;
  }

  /**
   * Finds the active tab that grants this extension the `activeTab` permission
   * (the only tab we may inject the session-creation probe into).
   * @returns {Promise<number|null>}
   */
  async function findActiveTabId() {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return Array.isArray(tabs) && typeof tabs[0]?.id === 'number' ? tabs[0].id : null;
    } catch {
      return null;
    }
  }

  /**
   * `LanguageModel.create()` is what the model actually needs. Some Chrome
   * versions/channels answer `availability()` optimistically and only throw
   * from `create()`, so as a last resort we try creating a probe session once.
   *
   * Content scripts are what the Chrome docs recommend for the prompt API, and
   * they get the current version (no cross-world `window.ai` shims).
   */
  async function probeWithContentScript(tabId) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const api = globalThis.LanguageModel || (globalThis.ai && globalThis.ai.languageModel);
          if (!api) return { ok: false };
          if (typeof api.availability === 'function') {
            const status = String((await api.availability()) || '').toLowerCase();
            if (status !== 'available' && status !== 'readily') return { ok: false };
          }
          if (typeof api.create !== 'function') return { ok: false };
          try {
            const session = await api.create({ monitor: () => {} });
            session.destroy();
            return { ok: true };
          } catch {
            return { ok: false };
          }
        },
      });
      return Boolean(injection && injection.result && injection.result.ok);
    } catch {
      return false;
    }
  }

  /**
   * @returns {Promise<{status: string, supported: boolean}>}
   *   `supported` = true only when a session can be created right now.
   */
  async function check() {
    const api = getApi();

    // A channel can expose `window.ai` but not its languageModel (the prompt
    // API is disabled) — that still counts as "use the content-script probe".
    if (!api || typeof api.create !== 'function' || typeof api.availability !== 'function') {
      // Popup pages on some channels do not expose the model on `window`.
      const tabId = await findActiveTabId();
      const ok = tabId !== null && (await probeWithContentScript(tabId));
      return ok ? { status: STATUS.AVAILABLE, supported: true } : { status: STATUS.UNAVAILABLE, supported: false };
    }

    let status = STATUS.UNAVAILABLE;
    try {
      if (typeof api.availability === 'function') {
        status = normalize(await api.availability());
      } else if (typeof api.capabilities === 'function') {
        status = normalize((await api.capabilities()).available);
      } else if (typeof api.create === 'function') {
        status = STATUS.AVAILABLE; // very old API: no availability() at all
      }
    } catch (err) {
      if (DEBUG) console.warn('[El Zatoona] availability() failed:', err);
      status = STATUS.UNAVAILABLE;
    }

    if (DEBUG) console.log('[El Zatoona] AI status:', status);
    const supported = status === STATUS.AVAILABLE || status === STATUS.DOWNLOADABLE || status === STATUS.DOWNLOADING;
    return { status, supported };
  }

  /* ------------------------------ Prompts ------------------------------ */

  /** Calibrates the model once per session: Arabic, short, direct answers. */
  const SYSTEM_PROMPT = 'أنت "الزتونة"، مساعد عربي مختصر. بترد بالعربية فقط، من غير مقدمات ولا حشو.';

  const PROMPTS = Object.freeze({
    article:
      'لخص المقال التالي باللغة العربية في 3 نقاط رئيسية واضحة ومباشرة. ' +
      'استخدم النقاط (١، ٢، ٣) في بداية كل نقطة، وكل نقطة سطر واحد قصير. ' +
      'اكتب بالعربية فقط، وماتضيفش أي مقدمة أو خاتمة أو كلام من عندك. ' +
      'المقال:',
    product:
      'أنت خبير تسوق. قم بتحليل بيانات هذا المنتج، وأعطني رأيك المباشر في سطرين ' +
      '(هل يستحق الشراء أم لا بناءً على التقييمات والمميزات). ' +
      'اكتب بالعربية فقط، وفي سطرين بالظبط، بدون مقدمة أو علامات Markdown. ' +
      'بيانات المنتج:',
  });

  /**
   * @param {'article'|'product'} type
   * @param {string} pageText  output of extractContent().text
   */
  function buildPrompt(type, pageText) {
    const base = type === 'product' ? PROMPTS.product : PROMPTS.article;
    return `${base}\n${pageText}`;
  }

  /* ------------------------------ Session ------------------------------ */

  /** Calls whatever create() shape this Chrome has (promise → callback style). */
  function createSession(api, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (session) => {
        if (!settled && session) {
          settled = true;
          resolve(session);
        }
      };
      try {
        const maybe = api.create(options, done);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(done, (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  /** One-shot prompt, whichever method this Chrome exposes. */
  async function prompt(session, text) {
    if (typeof session.prompt === 'function') return session.prompt(text);
    return session.promptStreaming(text); // older API only had streaming
  }

  async function destroy(session) {
    try {
      if (typeof session.destroy === 'function') session.destroy();
      else if (typeof session.close === 'function') await session.close();
    } catch {
      /* a stuck session must never break the UI */
    }
  }

  /**
   * Sends `promptText` to Gemini Nano and returns the final answer.
   *
   * @param {string} promptText
   * @param {{onDownload?: (loaded: number|undefined, total: number|undefined) => void}} [hooks]
   * @returns {Promise<string>}
   */
  async function generate(promptText, hooks) {
    const api = getApi();
    if (!api || typeof api.create !== 'function') {
      throw Object.assign(new Error('AI_UNSUPPORTED'), { code: 'AI_UNSUPPORTED' });
    }

    const monitor = (m) => {
      if (!m || typeof m.addEventListener !== 'function') return;
      m.addEventListener('downloadprogress', (e) => {
        if (hooks && typeof hooks.onDownload === 'function') hooks.onDownload(e.loaded, e.total);
      });
    };

    // Context size for the session. Chromium recommends at least 1k tokens for
    // the prompt API; long articles need much more, otherwise the model
    // rejects the input as too large. Supported in Chrome 138+; older builds
    // ignore unknown options, and the plain retry below covers the rest.
    const minPromptTokens = Math.min(8192, Math.max(1024, Math.ceil(String(promptText).length / 3)));

    // Not every Chrome build accepts every option — retry with fewer.
    const attempts = [
      {
        expectedInputs: [{ type: 'text', languages: ['ar'] }],
        expectedOutputs: [{ type: 'text', languages: ['ar'] }],
        language: 'ar',
        initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
        minPromptTokens,
        monitor,
      },
      { expectedInputs: [{ type: 'text', languages: ['ar'] }], minPromptTokens, monitor },
      { outputLanguage: 'ar', monitor },
      { monitor },
    ];

    let session = null;
    let lastError = null;
    for (const options of attempts) {
      try {
        session = await createSession(api, options);
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!session) throw lastError || new Error('AI_CREATE_FAILED');

    try {
      let answer;
      try {
        answer = await prompt(session, promptText);
      } catch (err) {
        // Context limits are per-session: one fresh session with the same
        // prompt usually fits when the model also had to load first.
        if (!/too (large|long)|context|exceed/i.test(String((err && err.message) || err))) throw err;
        await destroy(session);
        session = await createSession(api, attempts[0]);
        answer = await prompt(session, promptText);
      }

      return String(answer || '').trim();
    } finally {
      await destroy(session);
    }
  }

  return Object.freeze({ STATUS, check, buildPrompt, generate, getApi });
})();
