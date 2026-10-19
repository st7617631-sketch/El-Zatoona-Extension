// Read chrome.tabs.query diagnostics from a REAL popup window.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve('.');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const context = await chromium.launchPersistentContext(path.resolve('.qa/profile2'), {
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

const cdp = await context.newCDPSession(await context.newPage());

const tab = await context.newPage();
await tab.goto('https://www.amazon.eg/dp/B08N5WRWNW', { waitUntil: 'domcontentloaded' });
await tab.waitForTimeout(1000);

const { targetInfos } = await cdp.send('Target.getTargets');
const pageTarget = targetInfos.find((t) => t.type === 'page' && t.url.includes('amazon'));
const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId });

const { targetId } = await cdp.send('Target.createTarget', {
  url: `chrome-extension://${extId}/${manifest.action.default_popup}`,
  newWindow: true,
  windowId,
});
const win = await cdp.send('Browser.getWindowForTarget', { targetId });
await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { width: 340, height: 520, windowState: 'normal' } });
await new Promise((r) => setTimeout(r, 1200));

const popup = context.pages().find((p) => p.url().includes('/src/popup/popup.html'));
const diag = await popup.evaluate(async () => {
  const s = (l) => l.map((t) => ({ id: t.id, active: t.active, win: t.windowId, url: (t.url || '').slice(0, 40) }));
  return {
    selfWindow: (await chrome.tabs.getCurrent())?.windowId,
    all: s(await chrome.tabs.query({})),
    activeLastFocused: s(await chrome.tabs.query({ active: true, lastFocusedWindow: true })),
    activeCurrentWindow: s(await chrome.tabs.query({ active: true, currentWindow: true })),
    windows: (await chrome.windows.getAll({ populate: false })).map((w) => ({ id: w.id, type: w.type, focused: w.focused, incognito: w.incognito })),
  };
});
console.log(JSON.stringify(diag, null, 2));
await context.close();
