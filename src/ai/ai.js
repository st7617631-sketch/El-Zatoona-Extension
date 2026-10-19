/**
 * El Zatoona — Cloud AI client (Phase 4)
 * ---------------------------------------------------------------
 * Phase 3 talked to the browser's built-in model (window.ai / Gemini Nano).
 * Phase 4 moved everything to our own Vercel endpoint:
 *
 *   POST {ZATOONA_API_URL}
 *   { "type": "article" | "product", "text": "…", "title": "…" }
 *   → { "ok": true, "answer": "…" }
 *
 * The Gemini API keys live ONLY on the server (environment variables), never
 * in the extension. Loaded in popup.html BEFORE popup.js, so it exposes a
 * single global: `ZatoonaAI`.
 *
 * The file is also loaded by the QA scripts (.qa/*.mjs), so it must not touch
 * `document` or any other DOM node at load time.
 */

'use strict';

/* eslint-disable no-var */
var ZatoonaAI = (function () {
  /**
   * Production endpoint (Vercel) — the project's stable production alias.
   * QA override: `globalThis.ZATOONA_API_URL = 'http://localhost:3000/api/summarize'`
   */
  const DEFAULT_API_URL = 'https://el-zatoona-extension-vercel-backend.vercel.app/api/summarize';

  const TIMEOUT_MS = 45000;

  /** Result statuses of one cloud call. */
  const STATUS = Object.freeze({
    OK: 'ok',
    OUT_OF_QUOTA: 'out_of_quota', // every Gemini key on the server is exhausted
    SERVER_ERROR: 'server_error',
    OFFLINE: 'offline',
    TIMEOUT: 'timeout',
    EMPTY: 'empty',
  });

  function apiUrl() {
    return String(globalThis.ZATOONA_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  }

  /* ------------------------------ Prompts ------------------------------ */

  /**
   * The prompt is built here (not on the server) so the wording ships with
   * the extension and is easy to tweak; the server forwards it to Gemini.
   */
  const PROMPTS = Object.freeze({
    article:
      'لخص المقال التالي باللغة العربية في 3 نقاط رئيسية واضحة ومباشرة. ' +
      'استخدم النقاط (١، ٢، ٣) في بداية كل نقطة، وكل نقطة سطر واحد قصير. ' +
      'اكتب بالعربية فقط، وماتضيفش أي مقدمة أو خاتمة أو كلام من عندك.\n' +
      'المقال:',
    product:
      'أنت خبير تسوق. قم بتحليل بيانات هذا المنتج، وأعطني رأيك المباشر في سطرين ' +
      '(هل يستحق الشراء أم لا بناءً على التقييمات والمميزات). ' +
      'اكتب بالعربية فقط، وفي سطرين بالظبط، بدون مقدمة أو علامات Markdown.\n' +
      'بيانات المنتج:',
  });

  /**
   * @param {'article'|'product'} type
   * @param {string} pageText output of extractContent().text
   */
  function buildPrompt(type, pageText) {
    const base = type === 'product' ? PROMPTS.product : PROMPTS.article;
    return `${base}\n${pageText}`;
  }

  /* ------------------------------ Request ------------------------------ */

  /**
   * Sends the page text to the Vercel API and returns the Arabic answer.
   *
   * @param {{type: 'article'|'product', text: string, title?: string}} payload
   * @returns {Promise<string>}
   * @throws {Error & {status: string}} with `status` one of STATUS
   */
  async function summarize({ type, text, title }) {
    const body = {
      type,
      text: String(text || ''),
      title: String(title || '').slice(0, 200),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response;
    try {
      response = await fetch(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const status = err && err.name === 'AbortError' ? STATUS.TIMEOUT : STATUS.OFFLINE;
      throw Object.assign(new Error(status), { status, cause: err });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 429) {
      throw Object.assign(new Error((data && data.error) || STATUS.OUT_OF_QUOTA), {
        status: STATUS.OUT_OF_QUOTA,
      });
    }

    if (!response.ok || !data || data.ok !== true) {
      throw Object.assign(new Error((data && data.message) || `HTTP ${response.status}`), {
        status: STATUS.SERVER_ERROR,
        httpStatus: response.status,
      });
    }

    const answer = String(data.answer || '').trim();
    if (!answer) throw Object.assign(new Error(STATUS.EMPTY), { status: STATUS.EMPTY });

    return answer;
  }

  return Object.freeze({ STATUS, buildPrompt, summarize, apiUrl });
})();
