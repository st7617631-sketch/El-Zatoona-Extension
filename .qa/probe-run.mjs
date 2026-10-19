// Opens Chrome with the probe extension on an Amazon product page and waits for
// you to click the toolbar icon, then prints what the worker observed.
import { chromium } from 'playwright';
import path from 'node:path';

const extDir = path.resolve('.qa/probe-ext');
const context = await chromium.launchPersistentContext(path.resolve('.qa/profile-probe'), {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const tab = await context.newPage();
await tab.goto('https://www.amazon.eg/dp/B08N5WRWNW', { waitUntil: 'domcontentloaded' }).catch(() => { });
await tab.bringToFront();
console.log('READY — click the El Zatoona Probe icon in the toolbar now (you have 120s).');

let sw = context.serviceWorkers()[0];
for (let i = 0; i < 60 && !sw; i++) {
  await new Promise((r) => setTimeout(r, 250));
  sw = context.serviceWorkers()[0];
}
if (!sw) {
  for (let i = 0; i < 60 && !context.serviceWorkers()[0]; i++) await new Promise((r) => setTimeout(r, 500));
  sw = context.serviceWorkers()[0];
}
console.log('service worker:', sw ? sw.url() : 'none');

let probe = null;
for (let i = 0; i < 120 && !probe; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const p = await context.pages()[0]?.evaluate(() => null);
    void p;
  } catch { }
  if (sw) {
    probe = await sw.evaluate(async () => (await chrome.storage.local.get('probe')).probe).catch(() => null);
  }
}
console.log('PROBE RESULT:', JSON.stringify(probe, null, 2));
await context.close();
