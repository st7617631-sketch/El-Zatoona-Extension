// Render the popup for visual QA (mocked chrome APIs) and report layout metrics.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [state = 'product', out = `qa-${state}.png`] = process.argv.slice(2);

const urlFor = {
  product: 'https://www.amazon.eg/dp/B08N5WRWNW',
  article: 'https://ar.wikipedia.org/wiki/zaytoun',
  unsupported: 'chrome://extensions/',
  partial: 'https://www.noon.com/egypt-ar/p/12345.html',
  empty: 'https://www.amazon.com/dp/B08N5WRWNW',
  newday: 'https://www.noon.com/egypt-ar/p/999.html',
};

const today = new Date().toLocaleDateString('sv-SE');
const storeFor = {
  partial: { creditsLeft: 3, creditsDate: today, creditsTotal: 5 },
  empty: { creditsLeft: 0, creditsDate: today, creditsTotal: 5 },
  newday: { creditsLeft: 0, creditsDate: '2020-01-01', creditsTotal: 5 },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 560 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.addInitScript(({ url, store }) => {
  window.__writes = [];
  globalThis.chrome = {
    runtime: { lastError: undefined },
    tabs: { query: (_q, cb) => cb([{ url, title: 'mock' }]) },
    storage: {
      sync: {
        get: (keys, cb) => cb(Object.fromEntries(keys.map((k) => [k, store[k]]))),
        set: (obj, cb) => { window.__writes.push(obj); if (cb) cb(); },
      },
    },
  };
}, { url: urlFor[state], store: storeFor[state] ?? {} });

await page.goto(pathToFileURL(path.resolve('src/popup/popup.html')).href);
await page.waitForTimeout(350);

const metrics = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
  const visible = [...document.querySelectorAll('.state')].filter((el) => el.offsetParent !== null).map((el) => el.id);
  const btn = [...document.querySelectorAll('.cta')].find((b) => b.offsetParent !== null);
  return {
    visible,
    app: r(document.querySelector('.app')),
    cta: btn ? { text: btn.textContent.trim(), ...r(btn) } : null,
    credits: document.getElementById('credits-text').textContent.replace(/\s+/g, ' ').trim(),
    fill: document.getElementById('credits-fill').style.width,
    writes: window.__writes,
    logoLoaded: document.querySelector('.brand-logo').naturalWidth > 0,
  };
});

const height = Math.max(400, metrics.app.h);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 340, height } });
await browser.close();

console.log(JSON.stringify({ state, metrics, errors }, null, 2));
