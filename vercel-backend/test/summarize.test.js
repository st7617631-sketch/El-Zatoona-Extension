// Key-rotation tests for api/summarize.js — no network: global.fetch is mocked.
//
//   node test/summarize.test.js
'use strict';

const assert = require('node:assert/strict');
const handler = require('../api/summarize.js');

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

/** Mock response object close enough to Vercel's `res`. */
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk || '';
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

function req(body) {
  return { method: 'POST', headers: { origin: 'chrome-extension://test' }, body };
}

/** fetch mock: `plan` maps key → 'ok' | 429 | 500 | throw */
function mockFetch(plan, calls) {
  globalThis.fetch = async (url, options) => {
    const key = options.headers['x-goog-api-key'];
    calls.push(key);
    const action = plan[key];
    if (action === 'throw') throw new TypeError('fetch failed');
    if (action === 'ok') {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: `إجابة من ${key}` }] } }] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: { message: `quota for ${key}` } }), { status: action });
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const TEXT = 'هذا نص تجريبي طويل بما يكفي لاختبار الدالة من غير مشاكل في الحد الأدنى.';

test('uses the first key when it works', async () => {
  process.env.GEMINI_API_KEYS = 'k1,k2,k3';
  const calls = [];
  mockFetch({ k1: 'ok' }, calls);
  const res = mockRes();
  await handler(req({ type: 'article', text: TEXT }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.answer, 'إجابة من k1');
  assert.deepEqual(calls, ['k1']);
});

test('rotates to the next key on 429', async () => {
  process.env.GEMINI_API_KEYS = 'k1,k2,k3';
  const calls = [];
  mockFetch({ k1: 429, k2: 'ok' }, calls);
  const res = mockRes();
  await handler(req({ type: 'product', text: TEXT }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.keyIndex, 1);
  assert.deepEqual(calls, ['k1', 'k2']);
});

test('keeps rotating and returns 429 when every key is exhausted', async () => {
  process.env.GEMINI_API_KEYS = 'k1,k2';
  const calls = [];
  mockFetch({ k1: 429, k2: 429 }, calls);
  const res = mockRes();
  await handler(req({ type: 'article', text: TEXT }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json.error, 'all_keys_exhausted');
  assert.deepEqual(calls, ['k1', 'k2']);
});

test('rotates past broken / forbidden keys', async () => {
  process.env.GEMINI_API_KEYS = 'bad,forbidden,good';
  const calls = [];
  mockFetch({ bad: 400, forbidden: 403, good: 'ok' }, calls);
  // 400 is a request problem → must NOT burn the remaining keys.
  const res400 = mockRes();
  await handler(req({ type: 'article', text: TEXT }), res400);
  assert.equal(res400.statusCode, 400);
  assert.deepEqual(calls, ['bad']);

  calls.length = 0;
  mockFetch({ forbidden: 403, good: 'ok' }, calls);
  process.env.GEMINI_API_KEYS = 'forbidden,good';
  const res = mockRes();
  await handler(req({ type: 'article', text: TEXT }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['forbidden', 'good']);
});

test('parses GEMINI_API_KEYS as JSON array', async () => {
  process.env.GEMINI_API_KEYS = '["a", "b"]';
  const calls = [];
  mockFetch({ a: 429, b: 'ok' }, calls);
  const res = mockRes();
  await handler(req({ type: 'article', text: TEXT }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['a', 'b']);
});

test('the prompt contains the Arabic instruction and the page text', async () => {
  process.env.GEMINI_API_KEYS = 'k1';
  let sent = null;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'تمام' }] } }] }), { status: 200 });
  };
  const res = mockRes();
  await handler(req({ type: 'product', text: TEXT }), res);
  const prompt = sent.contents[0].parts[0].text;
  assert.ok(prompt.startsWith('أنت خبير تسوق'), prompt);
  assert.ok(prompt.includes(TEXT));
});

test('rejects short text and wrong methods without calling Gemini', async () => {
  process.env.GEMINI_API_KEYS = 'k1';
  const calls = [];
  mockFetch({ k1: 'ok' }, calls);
  const short = mockRes();
  await handler(req({ type: 'article', text: 'قصير' }), short);
  assert.equal(short.statusCode, 400);
  const get = mockRes();
  await handler({ method: 'GET', headers: {} }, get);
  assert.equal(get.statusCode, 405);
  assert.deepEqual(calls, []);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL  ${name}\n      ${err.message}`);
    }
  }

  globalThis.fetch = realFetch;
  process.env = realEnv;

  console.log(failed ? `\n${failed} failed` : `\nAll ${tests.length} backend cases passed`);
  process.exit(failed ? 1 : 0);
})();
