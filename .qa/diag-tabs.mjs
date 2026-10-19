// Diagnose what chrome.tabs.query returns inside the real popup.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve('.');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
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

const target = await context.newPage();
await target.goto('https://www.amazon.eg/dp/B08N5WRWNW', { waitUntil: 'domcontentloaded' });
console.log('target url:', target.url());
await new Promise((r) => setTimeout(r, 800));

// Option: popup opened in a regular tab (what we did so far) vs a chrome action popup window.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup.bringToFront();
await popup.waitForTimeout(500);

const diag = await popup.evaluate(async () => {
  const all = await chrome.tabs.query({});
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const currentWin = await chrome.tabs.query({ active: true, currentWindow: true });
  const self = await chrome.tabs.getCurrent();
  return {
    self: self && { id: self.id, windowId: self.windowId, url: self.url },
    all: all.map((t) => ({ id: t.id, active: t.active, windowId: t.windowId, url: (t.url || '').slice(0, 45) })),
    activeLastFocused: active.map((t) => (t.url || '').slice(0, 45)),
    activeCurrentWindow: currentWin.map((t) => (t.url || '').slice(0, 45)),
    windows: (await chrome.windows.getAll()).map((w) => ({ id: w.id, type: w.type, focused: w.focused })),
    perms: await chrome.permissions.getAll(),
  };
});
console.log(JSON.stringify(diag, null, 2));
await context.close();
