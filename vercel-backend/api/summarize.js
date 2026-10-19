/**
 * El Zatoona — Vercel Serverless Function (Node.js runtime)
 * ---------------------------------------------------------------
 * The extension POSTs the text it extracted from the page; this function
 * asks Gemini (Generative Language API) for the Arabic "zatoona" answer.
 *
 *   POST /api/summarize
 *   body: { "type": "article" | "product", "text": "…", "title": "…" }
 *   200:  { "ok": true, "answer": "…", "model": "…", "keyIndex": 0 }
 *   4xx/5xx: { "ok": false, "error": <code>, "message": "…" }
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEYS   several keys, comma / newline separated
 *                     "AIza…key1,AIza…key2,AIza…key3"
 *   GEMINI_API_KEY    single-key fallback (optional)
 *   GEMINI_MODEL      optional, default "gemini-3.5-flash-lite"
 *   ALLOWED_ORIGIN    optional, comma-separated CORS allow-list ("*" by default)
 *
 * Key rotation: the first key is tried; on 429 / quota errors (and also on
 * 401, 403 & 5xx, so one dead key never takes the service down) it moves to
 * the next key automatically. If every key is exhausted the function answers
 * 429 with `error: "all_keys_exhausted"`.
 *
 * `GET /api/summarize?diagnose=1` → never calls Gemini, only reports what the
 * function sees: number of keys, key prefixes, model, deployment env. Use it to
 * check a Vercel deployment in seconds (`keyCount === 0` ⇒ env var missing).
 *
 * No dependencies — plain Web `fetch`, so there is nothing to `npm install`.
 */

'use strict';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const MAX_TEXT_CHARS = 20000; // hard cap on what a browser may send
const MAX_PRODUCT_CHARS = 12000;
const REQUEST_TIMEOUT_MS = 25000; // stays under Vercel's function limit

/** Retry-with-another-key on these HTTP statuses. */
const ROTATE_ON = new Set([401, 403, 429, 500, 502, 503, 504]);

const PROMPTS = {
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
};

const SYSTEM_INSTRUCTION =
  'أنت "الزتونة"، مساعد عربي مختصر. بترد بالعربية فقط، من غير مقدمات ولا حشو.';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads every Gemini key from the environment, in order, without duplicates.
 * Supports GEMINI_API_KEYS as a JSON array, a JSON string, or a plain
 * comma / newline / semicolon separated list.
 * @returns {string[]}
 */
function readApiKeys() {
  const raw = [process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(',');

  const keys = [];

  const push = (value) => {
    const key = String(value || '').trim().replace(/^["']|["']$/g, '');
    if (key && !keys.includes(key)) keys.push(key);
  };

  let text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text);
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(push);
    } catch {
      // Not valid JSON → fall through to the plain-text split below.
    }
  }

  if (!keys.length) text.split(/[,;\r\n]+/).forEach(push);

  return keys;
}

function corsHeaders(origin) {
  const allowed = String(process.env.ALLOWED_ORIGIN || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const allowOrigin = allowed.includes('*') || !origin ? '*' : allowed.includes(origin) ? origin : allowed[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function send(res, status, payload, origin) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(corsHeaders(origin))) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel already parsed it
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_TEXT_CHARS * 2) req.destroy(); // abuse guard
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Turns one Gemini candidate into plain text. */
function textOf(data) {
  const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function buildPrompt(type, text) {
  const base = type === 'product' ? PROMPTS.product : PROMPTS.article;
  return `${base}\n${text}`;
}

/** One Gemini call with a single key. */
async function callGemini({ key, model, prompt, maxOutputTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens,
        },
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const geminiMessage =
        (data && data.error && data.error.message) || `Gemini HTTP ${response.status}`;
      console.error(`[summarize] Gemini ${response.status}:`, geminiMessage);
      const error = new Error(geminiMessage);
      error.status = response.status;
      error.retryable = ROTATE_ON.has(response.status);
      throw error;
    }

    return textOf(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('Gemini request timed out');
      timeout.status = 504;
      timeout.retryable = true;
      throw timeout;
    }
    if (typeof err.status !== 'number') {
      // Network/DNS failure — another key cannot help, but do not hide it.
      err.status = 502;
      err.retryable = false;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;

  // Diagnostic: what does this deployment actually see? No Gemini call.
  if (req.method === 'GET' && (req.query && req.query.diagnose)) {
    const keys = readApiKeys();
    send(
      res,
      200,
      {
        ok: true,
        diagnose: true,
        keyCount: keys.length,
        keyPrefixes: keys.map((k) => `${k.slice(0, 6)}…(${k.length})`),
        model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
        modelEnvSet: Boolean(process.env.GEMINI_MODEL),
        vercelEnv: process.env.VERCEL_ENV || null,
        commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      },
      origin,
    );
    return;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    for (const [name, value] of Object.entries(corsHeaders(origin))) res.setHeader(name, value);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method_not_allowed', message: 'Use POST.' }, origin);
    return;
  }

  const body = await readBody(req);
  if (!body || typeof body.text !== 'string') {
    send(res, 400, { ok: false, error: 'bad_request', message: 'Body must be JSON: { type, text }.' }, origin);
    return;
  }

  const type = body.type === 'product' ? 'product' : 'article';
  const text = body.text.trim().slice(0, type === 'product' ? MAX_PRODUCT_CHARS : MAX_TEXT_CHARS);

  if (text.length < 40) {
    send(res, 400, { ok: false, error: 'text_too_short', message: 'There is not enough text to summarise.' }, origin);
    return;
  }

  const keys = readApiKeys();
  if (!keys.length) {
    send(res, 500, { ok: false, error: 'no_keys', message: 'GEMINI_API_KEYS is not configured.' }, origin);
    return;
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const prompt = buildPrompt(type, text);
  const maxOutputTokens = type === 'product' ? 320 : 700;

  const failures = [];

  // Key rotation: first key → next key → … on quota / auth / transient errors.
  for (let index = 0; index < keys.length; index += 1) {
    try {
      const answer = await callGemini({ key: keys[index], model, prompt, maxOutputTokens });

      if (!answer) {
        failures.push({ index, status: 200, message: 'empty answer' });
        continue;
      }

      send(res, 200, { ok: true, answer, model, keyIndex: index }, origin);
      return;
    } catch (err) {
      failures.push({ index, status: err.status || 500, message: err.message });

      if (!err.retryable) {
        send(res, err.status || 502, { ok: false, error: 'gemini_failed', message: err.message }, origin);
        return;
      }
      // retryable → next key
    }
  }

  // Every key was rotated through without a usable answer.
  const exhausted = failures.every((f) => f.status === 429);
  console.error('[summarize] all keys failed:', JSON.stringify(failures));
  send(
    res,
    429,
    {
      ok: false,
      error: exhausted ? 'all_keys_exhausted' : 'gemini_unavailable',
      message: 'All Gemini keys failed. Try again in a minute.',
      attempts: failures.length,
      // The real Gemini status/message, so the extension console is enough to
      // diagnose a bad key or a retired model (never the key itself).
      failures,
    },
    origin,
  );
};
