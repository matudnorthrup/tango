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
- Common favorites:
  - **Double protein bowl** — the user's personal go-to
  - **"Best Buddies"** — a named favorite
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

## Troubleshooting

- **Click timeout on location**: The "Find a Chipotle" modal is blocking. Interact with the modal's search field instead.
- **Can't find favorites**: Make sure you're signed in. Check for a profile/account icon or "Recent Orders" link.
- **Page seems stuck**: Try a fresh navigation to `https://www.chipotle.com/order` and snapshot again.
