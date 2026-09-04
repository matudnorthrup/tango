/**
 * TGO-854: backfill Walmart listing data from purchase history.
 *
 * Connects to the managed Brave browser (CDP 9223, persistent Walmart login),
 * walks recent orders, and extracts every purchased item: name, item ID (from
 * /ip/<slug>/<id> links), and unit price paid. Output is a JSON work-list that
 * a matching pass turns into product_listings.retailer_item_id +
 * price_history rows (source 'receipt').
 *
 * Read-only against Walmart (navigation only, no cart/account mutations).
 * Paced: one page every few seconds, single tab.
 *
 *   node --import tsx scripts/backfill-walmart-listings.ts probe
 *   node --import tsx scripts/backfill-walmart-listings.ts orders [--max-orders N] [--out FILE]
 */
import fs from 'node:fs';
import { chromium, type Page } from 'playwright-core';

const mode = process.argv[2] ?? 'probe';
const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const maxOrders = Number(argOf('--max-orders') ?? 12);
const outFile = argOf('--out') ?? '/tmp/walmart-order-items.json';

const pace = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * 1500));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no browser context');
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.walmart.com/orders', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pace(3500);
    const url = page.url();
    const signedIn = !/login|signin|account\/login/i.test(url);
    console.log(`orders page: ${url} — signed in: ${signedIn}`);
    if (!signedIn) throw new Error('Walmart session is not signed in; refresh the browser session first.');

    if (mode === 'probe') {
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/orders/"]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => /\/orders\/\d/.test(h)),
      );
      const unique = [...new Set(links)];
      console.log(`order links found: ${unique.length}`);
      console.log(unique.slice(0, 8).join('\n'));
      const snippet = await page.evaluate(() => document.body.innerText.slice(0, 400));
      console.log('---\n' + snippet.replace(/\n+/g, ' | '));
      return;
    }

    if (mode === 'orders') {
      const orderLinks: string[] = await page.evaluate(() =>
        Array.from(
          new Set(
            Array.from(document.querySelectorAll('a[href*="/orders/"]'))
              .map((a) => (a as HTMLAnchorElement).href.match(/\/orders\/(\d+)/)?.[1])
              .filter((id): id is string => Boolean(id))
              .map((id) => `https://www.walmart.com/orders/${id}`),
          ),
        ),
      );
      console.log(`found ${orderLinks.length} order links; visiting up to ${maxOrders}`);
      const items: Array<Record<string, unknown>> = [];
      for (const link of orderLinks.slice(0, maxOrders)) {
        await pace(2500);
        try {
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await pace(3000);
          const extracted = await extractOrderItems(page);
          console.log(`  ${link.split('/orders/')[1]?.slice(0, 24)} → ${extracted.items.length} items (${extracted.date ?? 'no date'})`);
          for (const item of extracted.items) items.push({ ...item, order: link, order_date: extracted.date });
        } catch (error) {
          console.log(`  ! ${link}: ${(error as Error).message.slice(0, 120)}`);
        }
      }
      fs.writeFileSync(outFile, JSON.stringify(items, null, 2));
      console.log(`\nwrote ${items.length} purchased items → ${outFile}`);
      return;
    }

    if (mode === 'pdp') {
      // Visit each item's product page and pull current price + package data
      // from __NEXT_DATA__ — the same extraction the weekly scan will use.
      const ids = JSON.parse(fs.readFileSync(argOf('--ids') ?? '/tmp/wm-pdp-ids.json', 'utf8')) as string[];
      const results: Array<Record<string, unknown>> = [];
      for (const itemId of ids) {
        await pace(3000);
        try {
          await page.goto(`https://www.walmart.com/ip/${itemId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await pace(2500);
          const data = await extractPdp(page);
          results.push({ item_id: itemId, ...data });
          console.log(`  ${itemId}: $${data.price ?? '?'} · ${data.size ?? '?'} · ${data.servings_per_container ?? '?'} srv/ctr · ${String(data.name).slice(0, 44)}`);
        } catch (error) {
          results.push({ item_id: itemId, error: (error as Error).message.slice(0, 120) });
          console.log(`  ! ${itemId}: ${(error as Error).message.slice(0, 100)}`);
        }
      }
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
      console.log(`wrote ${results.length} PDP records → ${outFile}`);
      return;
    }

    if (mode === 'search') {
      // For products with no purchase match: run one search per query and
      // capture the top organic results for offline adjudication.
      const queries = JSON.parse(fs.readFileSync(argOf('--queries') ?? '/tmp/wm-queries.json', 'utf8')) as Array<{ key: string; q: string }>;
      const results: Array<Record<string, unknown>> = [];
      for (const { key, q } of queries) {
        await pace(3000);
        try {
          await page.goto(`https://www.walmart.com/search?q=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await pace(2500);
          const hits = await extractSearch(page);
          results.push({ key, q, hits });
          console.log(`  ${key}: ${hits.length} hits — ${hits[0]?.name?.slice(0, 50) ?? 'none'}`);
        } catch (error) {
          results.push({ key, q, error: (error as Error).message.slice(0, 120) });
          console.log(`  ! ${key}: ${(error as Error).message.slice(0, 100)}`);
        }
      }
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
      console.log(`wrote ${results.length} searches → ${outFile}`);
      return;
    }

    throw new Error(`unknown mode ${mode}`);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function extractOrderItems(page: Page): Promise<{ date: string | null; items: Array<{ name: string; item_id: string | null; price: number | null; qty: string | null }> }> {
  // Order data lives complete in __NEXT_DATA__: order lines carry
  // productInfo.{name, usItemId}, quantity, and priceInfo.linePrice. Passed as
  // a string because tsx/esbuild injects __name helpers into serialized
  // functions, which don't exist inside the page.
  return page.evaluate(`(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return { date: null, items: [] };
    const dateMatch = document.body.innerText.match(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \\d{1,2}, \\d{4}/,
    );
    const lines = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 30) return;
      if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
      if (o.quantity !== undefined && o.priceInfo && o.productInfo && o.productInfo.usItemId) lines.push(o);
      for (const v of Object.values(o)) walk(v, depth + 1);
    };
    walk(JSON.parse(nd.textContent), 0);
    const seen = new Set();
    const items = [];
    for (const l of lines) {
      const key = l.productInfo.usItemId + ':' + l.quantity;
      if (seen.has(key)) continue;
      seen.add(key);
      const lineTotal = l.priceInfo.linePrice ? l.priceInfo.linePrice.value : null;
      const qty = Number(l.quantity) || 1;
      items.push({
        name: l.productInfo.name,
        item_id: String(l.productInfo.usItemId),
        qty: String(qty),
        price: lineTotal !== null && qty > 0 ? Math.round((lineTotal / qty) * 100) / 100 : null,
      });
    }
    return { date: dateMatch ? dateMatch[0] : null, items };
  })()`) as Promise<{ date: string | null; items: Array<{ name: string; item_id: string | null; price: number | null; qty: string | null }> }>;
}

async function extractPdp(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return { error: 'no __NEXT_DATA__' };
    const j = JSON.parse(nd.textContent);
    let product = null, price = null, servings = null, size = null, name = null, inStock = null, unitPriceDisplay = null;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 30) return;
      if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
      if (!product && o.usItemId && o.priceInfo && (o.name || o.productName)) product = o;
      if (servings === null && o.servingsPerContainer !== undefined) servings = o.servingsPerContainer;
      if (servings === null && o.servingsPerContainerDisplayValue) servings = o.servingsPerContainerDisplayValue;
      for (const v of Object.values(o)) walk(v, depth + 1);
    };
    walk(j, 0);
    if (product) {
      name = product.name || product.productName;
      const pi = product.priceInfo;
      if (pi.currentPrice && typeof pi.currentPrice.price === 'number') price = pi.currentPrice.price;
      else if (pi.currentPrice && pi.currentPrice.priceString) {
        const m = pi.currentPrice.priceString.match(/[\\d.]+/); price = m ? Number(m[0]) : null;
      }
      if (pi.unitPrice && pi.unitPrice.priceString) unitPriceDisplay = pi.unitPrice.priceString;
      if (product.availabilityStatus) inStock = product.availabilityStatus === 'IN_STOCK';
      size = (name && (name.match(/([\\d.]+\\s*(?:oz|lb|fl oz|count|ct|g\\b))/i) || [])[1]) || null;
    }
    return { name, price, unit_price: unitPriceDisplay, servings_per_container: servings, size, in_stock: inStock };
  })()`) as Promise<Record<string, unknown>>;
}

async function extractSearch(page: Page): Promise<Array<{ item_id: string; name: string; price: number | null }>> {
  return page.evaluate(`(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    const hits = [];
    const seen = new Set();
    if (nd) {
      const walk = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 30 || hits.length > 40) return;
        if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
        if (o.usItemId && o.name && !seen.has(o.usItemId)) {
          seen.add(o.usItemId);
          let price = null;
          if (o.priceInfo && o.priceInfo.linePrice) { const m = String(o.priceInfo.linePrice).match(/[\\d.]+/); price = m ? Number(m[0]) : null; }
          else if (o.price && typeof o.price === 'number') price = o.price;
          hits.push({ item_id: String(o.usItemId), name: o.name, price });
        }
        for (const v of Object.values(o)) walk(v, depth + 1);
      };
      walk(JSON.parse(nd.textContent), 0);
    }
    return hits.slice(0, 8);
  })()`) as Promise<Array<{ item_id: string; name: string; price: number | null }>>;
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
