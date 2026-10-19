// Unit check for URL → page-type detection, using the real function from popup.js.
import { readFileSync } from 'node:fs';

const lines = readFileSync('src/popup/popup.js', 'utf8').split(/\r?\n/);
const cfg = lines.slice(14, 62).join('\n');        // config consts
const detect = lines.slice(83, 116).join('\n');    // detectPageType
const code = cfg + '\n' + detect;

const detectPageType = new Function(`${code}; return detectPageType;`)();

const cases = [
  // [url, expected]
  ['https://www.amazon.eg/dp/B08N5WRWNW', 'product'],
  ['https://amazon.com/dp/B0ABCDEFGH', 'product'],
  ['https://www.amazon.co.uk/gp/product/B08', 'product'],
  ['https://smile.amazon.com/dp/x', 'product'],
  ['https://www.noon.com/egypt-ar/headphone/123/p/', 'product'],
  ['https://noon.ae/english/xyz/p/', 'product'],
  ['https://ar.wikipedia.org/wiki/زيتون', 'article'],
  ['https://www.youtube.com/watch?v=abc123', 'article'],
  ['https://youtu.be/abc123', 'article'],
  ['https://medium.com/@someone/some-title', 'article'],
  ['https://example.com/some-article', 'article'],
  ['https://www.google.com/', 'unsupported'],
  ['https://www.google.com/search?q=test', 'unsupported'],
  ['https://example.com/', 'unsupported'],
  ['chrome://extensions/', 'unsupported'],
  ['about:blank', 'unsupported'],
  ['file:///C:/Users/me/a.html', 'unsupported'],
  ['', 'unsupported'],
  [undefined, 'unsupported'],
];

let failed = 0;
for (const [url, expected] of cases) {
  const got = detectPageType(url);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(url).padEnd(48)} → ${got} (expected ${expected})`);
}
console.log(failed ? `\n${failed} FAILED` : `\nAll ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
