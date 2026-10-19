// Verify activeTab is granted when Chrome's real browserAction (toolbar icon) is
// invoked — the only way the popup gets access to the page URL with `activeTab`
// and no host permissions.
import { chromium } from 'playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const extDir = path.resolve('.');
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const context = await chromium.launchPersistentContext(path.resolve('.qa/profile4'), {
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
console.log('extId', extId);

const cdp = await context.newCDPSession(await context.newPage());
const tab = await context.newPage();
await tab.goto('https://www.amazon.eg/dp/B08N5WRWNW', { waitUntil: 'domcontentloaded' });
await tab.bringToFront();
await tab.waitForTimeout(800);

const { targetInfos } = await cdp.send('Target.getTargets');
const pageTarget = targetInfos.find((t) => t.type === 'page' && t.url.includes('amazon'));

// Does the CDP browserAction domain exist here?
let invokeErr = null;
try {
  const res = await cdp.send('Extensions.invokeBrowserAction', { extensionId: extId, targetId: pageTarget.targetId });
  console.log('invoke ->', JSON.stringify(res));
} catch (e) {
  invokeErr = e.message;
  console.log('invoke failed:', e.message);
}

await new Promise((r) => setTimeout(r, 1500));
const popup = context.pages().find((p) => p.url().includes('/src/popup/popup.html'));
console.log('popup page found:', !!popup);
if (popup) {
  const state = await popup.evaluate(async () => ({
    tabs: (await chrome.tabs.query({})).map((t) => ({ active: t.active, win: t.windowId, url: (t.url || '').slice(0, 60) })),
    visible: [...document.querySelectorAll('.state')].filter((el) => el.offsetParent !== null).map((el) => el.id),
  }));
  console.log(JSON.stringify({ ...state, invokeErr }, null, 2));
  await popup.screenshot({ path: '.qa/shots/real-invoke.png' });
}
await context.close();
