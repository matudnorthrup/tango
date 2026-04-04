# walmart_shopping

Browser skill for adding items to the Walmart cart via browser automation.

## When to use

When the user asks to add items to their Walmart cart, do a Walmart grocery run, or shop for specific products on Walmart.com.

## Prerequisites

1. **Launch the browser first.** Use `browser` tool with `action: "launch"` — this starts Brave with remote debugging and connects automatically. If it's already running, it reconnects.
2. **Store must be set.** The store selector (top of page) should show the user's local store (Newport Supercenter, 97365). If it shows the wrong store, click the store selector and change it before searching.

## Workflow

### Step 1: Search for the item

Navigate directly to the search URL — do NOT use the search box interactively:

```
https://www.walmart.com/search?q=<item>
```

URL-encode the query if it contains spaces (e.g., `green%20onions`).

### Step 2: Read the search results

Take a `snapshot` (not interactive-only — you need the product details and prices).

Key things to look for in results:
- **"Overall pick"** badge — Walmart's recommended item, usually the best choice for common groceries
- **Availability**: "1 hour" or a specific time (e.g., "7pm") means available for local pickup/delivery today. "in 3+ days" means shipped — avoid these for groceries.
- **Price** — for produce and staples, prefer the cheapest fresh option
- **"Sponsored"** results appear first but are often irrelevant brands. Scroll past them to find the actual grocery items.

### Step 3: Add to cart

Click the **"Add to cart - ..."** button for the chosen item. The button text includes the full product name.

### Step 4: Confirm

After clicking, wait ~2 seconds, then re-snapshot. Verify:
- The **cart button in the header** updates (e.g., "Cart contains 1 item Total Amount $0.83")
- The "Add to cart" button changes to **quantity controls** (Decrease/Increase buttons)

If the cart count did not change, the add failed — retry or investigate.

### Step 5: Repeat for multiple items

For a grocery list with multiple items, repeat Steps 1–4 for each item. Navigate to a new search URL for each item — do NOT try to use the search box (typing into it triggers autocomplete which is unreliable).

## Item selection guidance

### Check purchase history first

Before searching on walmart.com, use the `walmart` tool to check if the user has bought this item before:

1. **`history_preferences`** — Shows saved product preferences with exact item names and IDs. If the item appears here (especially with `times_selected >= 3`), use that exact product name in the search to find the same one.
2. **`history_analyze`** — Shows purchase frequency and pricing for past items. Use this to match the right brand/size the user typically buys.

**Previously purchased items should always be prioritized** over "Overall pick" or cheapest option. The user has already chosen their preferred brand/size — respect that.

### General selection rules

- **Known preference exists**: Pick the exact item from purchase history, matching brand and size.
- **No preference / first-time item**: Fall back to the rules below.
- **Fresh produce**: Pick the simplest whole/fresh option, not pre-cut or organic unless specified. Look for "Overall pick" badge.
- **Pantry staples**: Prefer Great Value (Walmart store brand) for basics unless the user specified a brand.
- **Multiple sizes**: Pick the standard household size, not bulk/restaurant quantities.
- **Ambiguous items**: If the search returns many unrelated results (e.g., searching "cilantro" returns dried spices, chutneys, etc.), look specifically for fresh produce items with same-day availability.

## Login

Walmart cart works without login. However, checkout requires authentication. If you encounter a login wall:
1. Use `onepassword` tool: item "Walmart", vault "Watson"
2. Fill email, click Continue, fill password, click Sign In
3. Watch for MFA — if a verification code is needed, tell the user

## Troubleshooting

- **Bot detection / CAPTCHA**: The `launch` action starts a real browser profile which avoids Arkose Labs detection. Don't navigate too rapidly between pages — wait at least 1-2 seconds between actions.
- **"Item not available"**: The store may not carry it. Try a different product or check if the store selector is correct.
- **Snapshot too large**: Use `interactive: true` for a compact view showing only buttons/links, then switch to full snapshot only when you need to read product details and prices.
- **Page didn't load**: If `open` times out, the page may still be loading. Take a snapshot anyway — Walmart pages often work despite timeout warnings.

## Integration with walmart queue tool

The `walmart` tool manages a shopping queue (add/list/clear items). The typical flow is:
1. User adds items to the queue throughout the week via `walmart` tool (`queue_add`)
2. When it's time to shop, check the queue with `queue_list`
3. Use this browser skill to add each queued item to the Walmart cart
4. Clear processed items from the queue

## After shopping

Once all items are in the cart, tell the user what was added and the total. Do NOT proceed to checkout without explicit permission.
