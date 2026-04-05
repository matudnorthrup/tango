# walmart_orders

Browser skill for looking up Walmart order details. Extract items, prices, and order metadata to feed into receipt logging.

## When to use

When a Lunch Money transaction has a payee matching "walmart" or "wmt scan" and you need to identify what was ordered to categorize or split it.

## Navigation

### Order history page
```
https://www.walmart.com/orders
```

### Finding orders
- Orders are listed reverse-chronologically
- Match by **card charge amount** and **date** (±3 days)
- Click "View details" on the order, then "Show items" to expand the item list

## Important: Walmart Cash and totals

Walmart order totals may include Walmart Cash credits and delivery tips. The **card charge** (what appears in Lunch Money) can be less than the order total. Always match against the card charge amount, not the Walmart total.

Example:
- Walmart order total: $85.42
- Walmart Cash applied: -$3.20
- Delivery tip: $5.00
- Card charge: $87.22 (total + tip - Walmart Cash)

## Scan & Go orders

"WMT SCAN-N-GO" transactions are in-store purchases using the Walmart app. These won't appear in the online order history. For these:
1. Check the Walmart app purchase history (not available via browser)
2. Or ask the user to provide item details
3. Create a receipt with whatever information is available

## Extracting order data

From the order details page, collect:
- Order ID (format: `2000143-13986798`)
- Order date
- Each item: name, quantity, price
- Subtotal, tax, Walmart Cash applied, tip, card charge
- Delivery vs pickup

## Browser tips

- **`snapshot` works well** for Walmart — pages are lighter than Amazon.
- Click "View details" first, then "Show items" to expand the full item list.
- Walmart uses Arkose Labs bot detection — the real Brave profile avoids this, but don't navigate too rapidly.
- If items are truncated, scroll down to load more.

## Login

Walmart should have a persistent session in Brave. If you hit a login page:
1. Use the `onepassword` tool to get the installation's configured Walmart credentials
2. Enter email and password
3. Click Sign In

## Output

After extracting order data, pass structured results to the `receipt_logging` skill workflow for Obsidian file creation. Include:
- Order ID, date, card charge amount, order total (if different)
- Each item with name, quantity, individual price
- Whether Walmart Cash was applied (and how much)
- Which items are groceries vs. non-grocery (use category mappings from `receipt_logging`)
