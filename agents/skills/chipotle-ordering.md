# chipotle_ordering

Browser skill for placing Chipotle orders. Navigate to the site, select a pickup location, choose a saved favorite order, and add to bag.

## When to use

When the user asks to place a Chipotle order, queue up Chipotle, or get their usual bowl/order ready.

## Key URLs

- **Order page**: `https://www.chipotle.com/order`
- **Recent orders / favorites**: Available after sign-in from the order page

## Login

Chipotle should have a persistent session in Brave. If you hit a login page:
1. Use the `onepassword` tool to get the installation's configured Chipotle credentials
2. Enter email/phone and password
3. Complete any verification if prompted

## Ordering workflow

### 1. Navigate and take a snapshot

Go to `https://www.chipotle.com/order` and immediately take a snapshot to see the current page state. Don't click blindly.

### 2. Location selection — CRITICAL

Chipotle uses a **full-screen modal dialog** (`aria-label="Find a Chipotle"`) for location selection. This modal **intercepts all pointer events** on elements behind it.

- **Do NOT try to click through the modal** — it will time out every time.
- **Search by city/zip** in the modal's search field (e.g., "Corvallis, OR" or "97330").
- After search results appear, take a snapshot to see the list of locations.
- Click the correct location from the results, then click the **"Order"** or **"Start Order"** button for that location.
- Wait for the modal to close before proceeding. Take a snapshot to confirm you're past location selection.

If no modal appears (location already set from a previous session), verify the location shown is correct before proceeding.

### 3. Select a favorite order

The user has saved favorite orders on their Chipotle account. Instead of building a bowl from scratch:

- Look for a **"Recent Orders"** or **"Favorites"** / **"Faves"** section on the order page.
- Take a snapshot to find the saved orders.
- Current saved favorites (verified 2026-06-09):
  - **"Best Buddies"** — Chicken Burrito and Chicken Bowl
  - **"Family Usual"** — three Chicken Burritos
- Click the matching favorite, then confirm or **"Add to Bag"**.

If favorites aren't visible, check if there's a tab or link to switch from the menu to recent/favorite orders.

### 4. Add to bag (do NOT check out)

After selecting the favorite:
- Click **"ADD TO BAG"** if prompted.
- Take a snapshot to confirm the item is in the bag.
- **Stop here.** Do not proceed to checkout unless the user explicitly asks to place the order.

Report back what was added, the location, and the estimated pickup time if visible.

## Browser tips

- **Chipotle is a Vue.js SPA** — pages load dynamically. After any click that triggers navigation, wait briefly (use `waitForNavigation` or a short pause) then snapshot.
- **Snapshot works well** for most Chipotle pages — they're lighter than Amazon.
- **The location modal is the biggest obstacle.** If a click times out with "subtree intercepts pointer events", you're hitting the modal overlay. Search within the modal, don't try to dismiss it.
- **Customization steps use unnamed DIVs** — always snapshot before clicking to see what refs correspond to which options.
- **Take snapshots liberally** — Chipotle's UI changes state frequently. Snapshot after every significant action to stay oriented.

## Pickup time selection

The checkout page shows **5 quick time slots** (e.g., 4:50pm through 5:30pm) as radio-style options. These are not the only available times.

- There is a **"More Times"** button/dropdown below the visible slots that expands to show times up to ~3 hours out (e.g., 5:40pm through 8:00pm).
- The accessibility snapshot may NOT show this button or the expanded times — use `eval` or `screenshot` to confirm.
- After selecting a time from "More Times", the selected slot appears in a `div` with class `option pickuptime selected`. Confirm via `eval` before submitting.
- Do NOT assume Chipotle limits you to 40 minutes out — always check "More Times" first.

## Troubleshooting

- **Click timeout on location**: The "Find a Chipotle" modal is blocking. Interact with the modal's search field instead.
- **Can't find favorites**: Make sure you're signed in. Check for a profile/account icon or "Recent Orders" link.
- **Page seems stuck**: Try a fresh navigation to `https://www.chipotle.com/order` and snapshot again.
- **Pickup time appears limited**: Click "More Times" to expand the full time slot list before telling the user no later times are available.

## Removing items / emptying the bag (verified 2026-06-09)

- Item removal lives in the **bag drawer** (the add-to-bag modal on the order
  page), where each item row has **Remove / Edit / Duplicate** links — NOT on
  the checkout page, whose accessibility tree shows only totals.
- **Never navigate to `/order/checkout` to edit the bag.** That page has a live
  "Submit Order" button with the saved payment method. Clicking the header bag
  icon can navigate there directly — prefer re-opening the order page and using
  the drawer.
- Element refs go stale after any drawer/modal state change — re-snapshot
  before every click; if a ref-click times out, re-snapshot rather than retry.
- Check for stale items at the START of any cart flow: previous sessions can
  leave items in the bag (two stale items were found on 2026-06-09).

## Proven turn-saving recipes (verified working 2026-06-09)

Browser flows die by burning the tool-iteration budget on trial-and-error. These
`eval` snippets are verified against the live site — prefer them over
snapshot-hunt-click cycles for STATE CHECKS (use snapshots before real clicks):

- **Bag count without a snapshot** (1 call instead of snapshot+scan):
  `(() => { const b = document.querySelector("[class*=bag] [class*=count], [class*=cart-count], [data-qa*=bag]"); return b ? b.textContent.trim() : "empty"; })()`
- **Open the bag drawer from the order page** (do NOT click the header bag icon
  — it can navigate to checkout):
  `(() => { const t = document.querySelector("[class*=bag-icon-container]"); if (t) { t.click(); return "opened"; } return "no trigger"; })()`
  …then wait 3s; the drawer shows each item with Remove / Edit / Duplicate links.
- **Remove an item from the open drawer**:
  `(() => { const r = [...document.querySelectorAll("a,button,[role=button]")].filter(e => /^\s*remove\s*$/i.test(e.textContent||"")); if (!r.length) return "none"; r[0].click(); return "removed, " + (r.length-1) + " left"; })()`
- **Confirm empty bag**:
  `(() => /bag is empty|nothing in your bag/i.test(document.body.textContent) ? "empty" : "not empty")()`

Budget discipline: a clean roundtrip is ~25-45 calls; if you are past ~50 calls
and not on the final verification, stop exploring, state exactly where you are
and what remains.
