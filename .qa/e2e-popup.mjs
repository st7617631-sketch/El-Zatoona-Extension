// E2E with the popup opened the way Chrome opens it: in a real popup window.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve('.');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

// Keep one profile per run so the extension-loading state is clean.
const context = await chromium.launchPersistentContext(path.resolve('.qa/profile'), {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const extPage = await context.newPage();
await extPage.goto('chrome://extensions/');
const extId = await extPage.evaluate(() => {
  const items = document.querySelector('extensions-manager')?.shadowRoot
    ?.querySelector('extensions-item-list')?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
  return items[0]?.id ?? null;
});
await extPage.close();
if (!extId) {
  console.log(JSON.stringify({ error: 'extension not loaded' }));
  await context.close();
  process.exit(1);
}

const popupRel = manifest.action.default_popup;
const cdp = await context.newCDPSession(await context.newPage());

async function openRealPopup() {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const pageTarget = targetInfos.find((t) => t.type === 'page');
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId });
  const { targetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extId}/${popupRel}`,
    newWindow: true,
    windowId,
  });
  // Turn the new browser window into an actual popup window.
  const win = await cdp.send('Browser.getWindowForTarget', { targetId });
  await cdp.send('Browser.setWindowBounds', {
    windowId: win.windowId,
    bounds: { width: 340, height: 520, windowState: 'normal' },
  });
  return targetId;
}

async function waitForPopupPage() {
  for (let i = 0; i < 40; i++) {
    const page = context.pages().find((p) => p.url().includes('/src/popup/popup.html'));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function disposePopup() {
  const page = await waitForPopupPage();
  if (page) {
    const s = await context.newCDPSession(page);
    const { windowId } = await s.send('Browser.getWindowForTarget', { targetId: page._guid ?? undefined }).catch(() => ({}));
    await page.close();
    if (windowId) await cdp.send('Browser.closeWindow', { windowId }).catch(() => { });
  }
}

async function runCase(name, target) {
  const tab = await context.newPage();
  await tab.goto(target, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('nav:', e.message.split('\n')[0]));
  await tab.bringToFront();
  await tab.waitForTimeout(700);

  await openRealPopup();
  const popup = await waitForPopupPage();
  await popup.waitForTimeout(800);

  const state = await popup.evaluate(() => {
    const visible = [...document.querySelectorAll('.state')].filter((el) => el.offsetParent !== null).map((el) => el.id);
    const btn = [...document.querySelectorAll('.cta')].find((b) => b.offsetParent !== null);
    return {
      visible,
      cta: btn?.textContent.trim() ?? null,
      credits: document.getElementById('credits-text').textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  await popup.screenshot({ path: `.qa/shots/real-${name}.png` }).catch(() => { });
  console.log(JSON.stringify({ case: name, target: tab.url(), state }));

  await popup.close();
  await tab.close();
}

await runCase('product', 'https://www.amazon.eg/dp/B08N5WRWNW');
await runCase('article', 'https://ar.wikipedia.org/wiki/%D8%B2%D9%8A%D8%AA%D9%88%D9%86');
await runCase('unsupported', 'https://www.google.com/');

await context.close();
