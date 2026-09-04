/**
 * Amazon side of the listing backfill (TGO-854): order-history item extraction
 * and per-ASIN current prices, over the managed Brave session. Read-only.
 * Amazon has no __NEXT_DATA__; extraction is DOM-based and deliberately
 * shallow (names, ASINs, dates from history cards; price + size from PDPs).
 *
 *   node --import tsx scripts/backfill-amazon-listings.ts history [--pages N] [--out FILE]
 *   node --import tsx scripts/backfill-amazon-listings.ts pdp --asins FILE [--out FILE]
 */
import fs from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const mode = process.argv[2] ?? 'history';
const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const pages = Number(argOf('--pages') ?? 3);
const outFile = argOf('--out') ?? '/tmp/amazon-items.json';
const pace = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * 1500));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context');
  const page = await ctx.newPage();
  try {
    if (mode === 'history') {
      const items: Array<Record<string, unknown>> = [];
      for (let i = 0; i < pages; i++) {
        const url = `https://www.amazon.com/gp/css/order-history?startIndex=${i * 10}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await pace(3500);
        if (page.url().includes('/ap/signin')) throw new Error('Amazon signed out');
        const extracted = await extractHistory(page);
        console.log(`page ${i + 1}: ${extracted.length} items`);
        items.push(...extracted);
        if (extracted.length === 0) break;
        await pace(2500);
      }
      fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
      console.log(`wrote ${items.length} items → ${outFile}`);
      return;
    }
    if (mode === 'pdp') {
      const asins = JSON.parse(fs.readFileSync(argOf('--asins') ?? '/tmp/az-asins.json', 'utf8')) as string[];
      const results: Array<Record<string, unknown>> = [];
      for (const asin of asins) {
        await pace(3500);
        try {
          await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await pace(3000);
          const data = await extractPdp(page);
          results.push({ asin, ...data });
          console.log(`  ${asin}: $${data.price ?? '?'} · ${String(data.title).slice(0, 60)}`);
        } catch (error) {
          results.push({ asin, error: (error as Error).message.slice(0, 120) });
          console.log(`  ! ${asin}: ${(error as Error).message.slice(0, 100)}`);
        }
      }
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
      console.log(`wrote ${results.length} PDP records → ${outFile}`);
      return;
    }
    throw new Error(`unknown mode ${mode}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function extractHistory(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(`(() => {
    const items = [];
    const cards = Array.from(document.querySelectorAll('.order-card, .js-order-card, [class*="order-card"]'));
    for (const card of cards) {
      const header = card.innerText || '';
      const dateMatch = header.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December) \\d{1,2}, \\d{4}/);
      const totalMatch = header.match(/Total[^$]*\\$([\\d,.]+)/i) || header.match(/\\$([\\d,.]+)/);
      const seen = new Set();
      const links = Array.from(card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'));
      const named = links.filter(a => (a.innerText || '').trim().length > 10);
      for (const a of named) {
        const asinMatch = a.href.match(/(?:\\/dp\\/|\\/gp\\/product\\/)([A-Z0-9]{10})/);
        if (!asinMatch || seen.has(asinMatch[1])) continue;
        seen.add(asinMatch[1]);
        items.push({
          asin: asinMatch[1],
          name: a.innerText.trim().slice(0, 140),
          order_date: dateMatch ? dateMatch[0] : null,
          order_total: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null,
          single_item_order: named.length === 1,
        });
      }
    }
    return items;
  })()`) as Promise<Array<Record<string, unknown>>>;
}

async function extractPdp(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const title = (document.getElementById('productTitle') || {}).innerText || document.title;
    let price = null;
    const core = document.querySelector('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, span.a-price .a-offscreen');
    if (core) { const m = core.innerText.match(/[\\d,.]+/); price = m ? Number(m[0].replace(/,/g, '')) : null; }
    const sizeMatch = (title || '').match(/([\\d.]+)\\s*(lb|lbs|pound|oz|ounce|g|kg)\\b/i);
    const unavailable = /currently unavailable/i.test(document.body.innerText.slice(0, 5000));
    return { title: (title || '').trim().slice(0, 140), price, size: sizeMatch ? sizeMatch[0] : null, unavailable };
  })()`) as Promise<Record<string, unknown>>;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
