// Real-extension QA: loads the unpacked extension into real Chrome (Chromium build),
// opens the real popup page against different tab types and reports what it renders.
//
// usage: node .qa/e2e.mjs <extensionDir>
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));

const context = await chromium.launchPersistentContext(path.resolve('.qa/profile'), {
  channel: 'chromium', // required: extensions work in Chromium, not in Playwright's bundled headless shell
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

// No service worker in this extension, so read the ID straight from chrome://extensions.
const extPage = await context.newPage();
await extPage.goto('chrome://extensions/');
const extId = await extPage.evaluate(() => {
  const mgr = document.querySelector('extensions-manager');
  const items = mgr?.shadowRoot?.querySelector('extensions-item-list')
    ?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
  return items[0]?.id ?? null;
});
await extPage.close();
console.log(JSON.stringify({ step: 'load', extId, name: manifest.name }));

if (!extId) {
  await context.close();
  process.exit(1);
}

const popupUrl = `chrome-extension://${extId}/${manifest.action.default_popup}`;

/** Opens `target`, makes it active, then opens the popup page and reads it. */
async function runCase(name, target) {
  const tab = await context.newPage();
  await tab.goto(target, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('nav:', e.message.split('\n')[0]));
  await tab.bringToFront();

  // Must be the active tab in the (only) window for chrome.tabs.query to return it.
  await new Promise((r) => setTimeout(r, 800));

  const popup = await context.newPage();
  const errors = [];
  popup.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.goto(popupUrl);

  await popup.waitForTimeout(700);

  const state = await popup.evaluate(() => {
    const visible = [...document.querySelectorAll('.state')].filter((el) => el.offsetParent !== null).map((el) => el.id);
    const btn = [...document.querySelectorAll('.cta')].find((b) => b.offsetParent !== null);
    return {
      visible,
      cta: btn?.textContent.trim() ?? null,
      credits: document.getElementById('credits-text').textContent.replace(/\s+/g, ' ').trim(),
      fill: document.getElementById('credits-fill').style.width,
    };
  });

  await popup.screenshot({ path: `.qa/shots/real-${name}.png`, clip: { x: 0, y: 0, width: 340, height: 520 } });
  await popup.close();
  await tab.close();
  console.log(JSON.stringify({ case: name, target, state, errors }));
}

await runCase('product', 'https://www.amazon.eg/dp/B08N5WRWNW');
await runCase('article', 'https://ar.wikipedia.org/wiki/%D8%B2%D9%8A%D8%AA%D9%88%D9%86');
await runCase('unsupported', 'https://www.google.com/');

await context.close();
