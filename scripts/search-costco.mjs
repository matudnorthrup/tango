/**
 * Costco product search over the managed Brave session (CDP 9223, persistent
 * Costco login). Read-only: navigation + result parsing only.
 *
 * Costco has no public price API and no __NEXT_DATA__ blob like Walmart, so
 * results are parsed from the DOM: product links carry the item id in the URL
 * (`...product.<id>.html`) and the price lives in an ancestor of the link.
 *
 *   node scripts/search-costco.mjs "bacon crumbles"
 */
import { chromium } from 'playwright-core';

const query = process.argv[2];
if (!query) {
  console.error('usage: node scripts/search-costco.mjs "<search terms>"');
  process.exit(1);
}
const filter = new RegExp(process.argv[3] ?? query.split(/\s+/)[0], 'i');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = await browser.contexts()[0].newPage();
try {
  await page.goto(`https://www.costco.com/s?keyword=${encodeURIComponent(query)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await page.waitForTimeout(6000);
  const items = await page.evaluate(
    `(() => {
      const seen = new Set(); const out = [];
      for (const a of Array.from(document.querySelectorAll('a[href*=".product."]'))) {
        const id = (a.href.match(/product\\.(\\d+)/) || [])[1] || null;
        const name = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\n+/g, ' ').trim();
        if (!name || name.length < 12 || seen.has(name)) continue;
        let node = a, price = null;
        for (let i = 0; i < 6 && node; i++) {
          const m = (node.innerText || '').match(/\\$[\\d,]+\\.\\d{2}/);
          if (m) { price = m[0]; break; }
          node = node.parentElement;
        }
        seen.add(name);
        out.push({ id, name: name.slice(0, 90), price, url: a.href });
        if (out.length >= 12) break;
      }
      return out;
    })()`,
  );
  const matches = items.filter((i) => filter.test(i.name));
  for (const i of (matches.length ? matches : items)) {
    console.log(`  ${i.id ?? '—'} ${i.price ?? '$?'} | ${i.name}\n      ${i.url}`);
  }
  if (!items.length) console.log('no results parsed — check the Costco session is signed in');
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
