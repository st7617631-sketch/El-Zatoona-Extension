// Compare detection strategies inside the real popup:
//  (a) tabs.query filtered by type:"normal" (skips the popup tab)
//  (b) last-focused normal window
// Also read the granted permissions.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve('.');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const context = await chromium.launchPersistentContext(path.resolve('.qa/profile3'), {
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
await tab.bringToFront();
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
const out = await popup.evaluate(async () => {
  const self = await chrome.tabs.getCurrent();
  const all = await chrome.tabs.query({});
  const normal = all.filter((t) => (t.url || '').startsWith('http'));
  const selfTab = all.find((t) => t.id === self.id);
  return {
    permissions: await chrome.permissions.getAll(),
    selfActive: selfTab?.active,
    selfWindow: self.windowId,
    normalInSelfWindow: normal.filter((t) => t.windowId === self.windowId).map((t) => ({ active: t.active, url: (t.url || '').slice(0, 50) })),
    normalAll: normal.map((t) => ({ win: t.windowId, active: t.active, url: (t.url || '').slice(0, 50) })),
  };
});
console.log(JSON.stringify(out, null, 2));
await context.close();
