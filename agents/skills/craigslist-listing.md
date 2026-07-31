# craigslist_listing

Browser skill for posting for-sale listings to Craigslist. Companion to
[`marketplace-listing.md`](marketplace-listing.md) (Facebook Marketplace); use that one
for the shared description-writing and photo-ordering guidance.

## When to use

When the user wants something posted to Craigslist, usually as a cross-post alongside
Facebook Marketplace.

## Browser

Tango's managed **Brave** over CDP 9223 — the Craigslist session lives there. See
[`browser.md`](../tools/browser.md).

```js
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
// ... work ...
await b.close(); process.exit(0);   // REQUIRED — a live CDP connection keeps node alive
```

## Flow (verified end to end)

```
https://post.craigslist.org
  ?s=copyfromanother  → "copy from previous"   ← APPEARS ONLY FOR ACCOUNTS WITH HISTORY
  ?s=area             → choose area
  ?s=type             → for sale by owner
  ?s=cat              → category
  ?s=edit             → posting details
  ?s=geoverify        → add map / area confirmation
  ?s=editimage        → images
  ?s=preview          → shows the charge, "this is an unpublished draft"  ← STOP HERE
```

**The `copyfromanother` step is a trap.** It offers to re-use region, location, and
**category** from the previous posting. Accepting it can silently inherit a wrong
category. Click **skip** unless the previous post is known-good.

Craigslist allows one area per posting, and posting the same item to multiple areas is
overposting. Pick the area deliberately: the nearest *large* metro usually reaches far
more buyers than the nearest small one, and that tradeoff belongs to the user — ask.

### The geoverify area prompt

If the ZIP belongs to a different region than the flow's current one, Craigslist shows
two buttons and no obvious continue:

| Button | `name` |
| --- | --- |
| the ZIP's region | `area_change_ok` |
| the current region | `keep_old_area` |

Click one of those — a generic `continue` locator won't advance, and `#regular_continue_button`
is hidden. The `find` button stays **disabled** without a street address; skip the map
rather than publishing a home address.

## CRITICAL: the container-label trap

Category and type options are radio buttons wrapped in labels, **inside an outer
`<label>` whose `innerText` contains every option**. So this silently picks the wrong
category:

```js
// WRONG — .first() matches the outer container label, not the option
await page.locator('label', {hasText:/motorcycles\/scooters/i}).first().click();
```

The click lands on the container and selects whatever radio is under that coordinate.
It fails **silently** and the post can go live in the wrong category, potentially
skipping a required fee and making the mistake easy to miss.

Select the radio directly and **verify before continuing**:

```js
const opt = page.getByRole('radio', { name: /^motorcycles\/scooters/i });
await opt.check();
const ok = await opt.isChecked();
if (!ok) throw new Error('category not selected');
```

**Always verify the category after posting** at
`https://accounts.craigslist.org/login/home` — the postings table has an
"area and category" column (e.g. `cor motorcycles/scooters - by owner`). Check it every
time; it is the only place the mistake is visible.

## Category cannot be changed after posting

Craigslist has no category edit. Fixing a miscategorized post means **delete and
repost** — which is a destructive action, so confirm with the user first. Editing text,
price, and photos on a live post is fine.

## Paid categories

These charge a fee and route through a payment step:

| Category | Fee |
| --- | --- |
| motorcycles/scooters | $5 |
| cars & trucks | $5 |
| rvs | $5 |

Most other for-sale-by-owner categories are free. **Never complete a paid post without
explicit user authorization** — it's a real charge to a card on file. Fill the form,
stop at payment, and hand off. A post that completed with no payment prompt in a
nominally paid category is a red flag that the category is wrong.

## Posting details form

Plain HTML — ordinary `fill()` works, no combobox dance.

| Field | Notes |
| --- | --- |
| `PostingTitle` | |
| `price` | number only |
| `postal` | ZIP |
| `geographic_area` | free text shown to buyers, e.g. "Northside" |
| `PostingBody` | textarea, accepts limited HTML |
| `sale_manufacturer` / `sale_model` / `sale_size` | generic for-sale categories only |
| `condition` | select: new / like new / excellent / good / fair |
| `city`, `xstreet0`, `xstreet1` | **disabled** unless `show_address_ok` is checked — skip or check the box first |
| `contact_phone`, `contact_text_ok`, `show_phone_ok` | defaults to the CL email relay; never add a phone number without asking |

Make the fill helper tolerant — check `isDisabled()` and log-and-skip rather than
throwing, or one locked field aborts the whole run.

If `selectOption` times out on `condition`, set it via JS and dispatch the event:

```js
await page.evaluate(() => {
  const s = document.querySelector('[name="condition"]');
  s.selectedIndex = [...s.options].findIndex(o => /^excellent$/i.test(o.text.trim()));
  s.dispatchEvent(new Event('change', { bubbles: true }));
});
```

### Vehicle categories have their own fields

`motorcycles/scooters` does **not** use `sale_manufacturer`/`sale_model`. Field names
differ per category — always enumerate before filling:

| Field | Value used |
| --- | --- |
| `auto_make_model` | vehicle make and model |
| `auto_miles` | odometer |
| `auto_year` | select |
| `engine_displacement_cc` | 998 |
| `motorcycle_type` | select — adventure / cruiser / dual-sport / … |
| `motorcycle_motor_type` | gas / electric / other |
| `auto_title_status` | clean / salvage / rebuilt / lien / … |
| `auto_transmission` | manual / automatic / other |
| `motorcycle_street_legal` | checkbox |
| `auto_vin` | **leave blank by default** — public VIN enables title cloning |

## Images

The uploader is slow — roughly 15–20 s per 3–4 MB photo, so a dozen originals take
~4 minutes. `setInputFiles()` the whole ordered array at once, then **poll the
"this posting has N images" counter until it reaches the expected count** before
clicking "done with images". Don't navigate while uploading.

## The preview step is the stop line

`?s=preview` shows the category, the total charge, and "this is an unpublished draft".
The next `continue` triggers payment. **Stop here and hand off** unless the user has
explicitly authorized the charge. This screen is also the last easy place to verify the
category before money moves.

Vehicle posts expire in **30 days**.

## Editing a live post

From the account page, the row's `edit` submit button lands you on the **preview**, not
the editor. You must then click **"edit post"** to reach `?s=edit` where `PostingBody`
lives. Publishing straight from that preview silently re-posts the listing unchanged.

Guard against this: after writing the new body, compare before/after and **abort if
nothing changed** rather than clicking publish on an unmodified post.

```js
const before = t.value;
const after  = before.replace(/…/, '').trim();
if (before === after) throw new Error('nothing changed — do not publish');
```

Editing text and price on a live post is fine. Category cannot be changed (see above).

## Never offer logistics the user hasn't agreed to

Do not put "happy to meet in <city>" or any meet-partway offer in a listing unless the
user has explicitly said they will travel. Default to pickup at the seller's location.
See [`marketplace-listing.md`](marketplace-listing.md) for the full rule.

## Drafts accumulate

Every run through `post.craigslist.org` creates a **new draft**. Re-running a script
several times leaves several drafts and it becomes easy to fill one draft and publish a
different one. **Reuse the open `?s=edit` page rather than restarting the flow** — this
is the actual fix, because strays cannot be cleaned up afterward.

Draft rows on the `drafts` tab contain only a link — no delete control, unlike active
postings. Opening a draft resumes the posting flow with no cancel option. They appear to
age out on their own. Don't promise the user you've removed them; verify before claiming
any deletion succeeded.

## After posting

- Posts expire (~45 days for vehicles). Renew from the account home to keep them fresh.
- Verify area + category, then open the live URL and confirm photos and body rendered.
- Cross-check that the price and description match the Facebook listing.
