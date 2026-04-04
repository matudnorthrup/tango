# amazon_orders

Browser skill for looking up Amazon order details. Extract items, prices, and order metadata to feed into receipt logging.

## When to use

When a Lunch Money transaction has a payee matching "amazon" and you need to identify what was ordered to categorize or split it.

## Navigation

### Order history page
```
https://www.amazon.com/gp/your-account/order-history
```

### Order details page (if you have the order ID)
```
https://www.amazon.com/gp/your-account/order-details?orderID={ORDER_ID}
```

### Searching by date range
The order history page has filter options. Use the dropdown to select a time range, or scroll to find orders by date.

## Finding the right order

Match by:
1. **Amount** — exact match against the Lunch Money transaction amount
2. **Date** — within ±3 days of the transaction date (shipping/charge date can differ)

Order ID formats:
- `111-*` or `114-*` = physical orders
- `D01-*` = digital orders

## Extracting order data

From the order details page, collect:
- Order ID
- Order date
- Each item: name, quantity, price
- Order total
- Shipping cost (if any)

## Browser tips

- **Use `screenshot` first** — Amazon pages are heavy; screenshot is more reliable than snapshot for getting an overview.
- **Then `snapshot`** for clickable refs when you need to interact (click into order details, navigate pages).
- **Close unused tabs** before starting to improve reliability.
- Amazon's order history is paginated — if the order isn't visible, try filtering by date range.

## Login

Amazon should have a persistent session in Brave. If you hit a login page:
1. Use the `onepassword` tool to get credentials: item name "Amazon", vault "Watson"
2. Enter email, click Continue
3. Enter password, click Sign-In
4. **2FA may be required** — if prompted, report back and ask the user to complete it

## Output

After extracting order data, pass structured results to the `receipt_logging` skill workflow for Obsidian file creation. Include:
- Order ID, date, total
- Each item with name, quantity, individual price
- Which items are groceries vs. non-grocery (use category mappings from `receipt_logging`)
