# marketplace_listing

Browser skill for creating for-sale listings on Facebook Marketplace (and Craigslist)
from a structured item spec. Built for vehicles; the same flow works for general items.

## When to use

When the user wants to list something for sale and has photos plus a description ready.
Typical trigger: "list my X on Facebook / Craigslist."

## Browser

Use Tango's managed **Brave** over CDP — persistent logins live there. See
[`browser.md`](../tools/browser.md). From Claude Code, drive it directly:

```js
import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = b.contexts()[0].pages().find(p => p.url().includes('marketplace/create'));
```

Run the script from the Tango repository so `node_modules` resolves.
Always `await b.close()` — a dangling CDP connection hangs the process until timeout.

## HARD RULE: never publish without confirmation

Fill every field, upload photos, screenshot the completed form, show the user, and
**stop**. Publishing is public and irreversible. The user clicks the final button, or
explicitly says "publish" first. This holds even when they said "post it for me" at the
start — they're approving the *content*, which they haven't seen yet.

Leave the **VIN blank by default** on vehicle listings. It auto-populates specs but a
public VIN enables title-cloning scams. Offer it; don't assume.

## Reading photos from protected folders

Some desktop folders may be unavailable to the runtime because of operating-system
privacy controls. If a photo cannot be read, report the access constraint and ask the
user to make it available through the configured working folder; do not bypass the
platform's permission model.

Review photos before uploading: downscale with `sips -Z 700`, tile with
`montage -tile 4x3`, and read the contact sheet. Detail shots often confirm spec
details the paper trail missed (brand of an accessory, the odometer reading).

## Facebook Marketplace — vehicle flow

```
https://www.facebook.com/marketplace/create/vehicle
```

Field order matters. **Set `Vehicle type` first**, then `Year`, then everything else.

### Control shapes (they are not uniform)

| Field | Selector shape |
| --- | --- |
| Vehicle type, Year, Make, Exterior color, Fuel type, Transmission | `label[role="combobox"]` filtered by text → click → click `[role="option"]` |
| Model, Mileage, Price, VIN | `label:has-text("<Name>") input` → `fill('')` then `type()` |
| Description | `label:has-text("Description") textarea` → `fill()` |
| Location | `input[aria-label="Location"]` → type → **must click the `[role="option"]`** or it won't commit |
| Photos | `input[type="file"][accept*="image"]` → `setInputFiles([...])`, up to 20 |

**The gotcha:** `Make` renders as a plain label until `Year` is set, then becomes a
combobox. Fill `Year` first or `Make` silently no-ops. Verify every field afterward by
reading back `label` → `input.value`; a combobox that failed leaves no error.

`Vehicle type` options: Car/Truck, Motorcycle, Powersport, RV/Camper, Trailer, Boat,
Commercial/Industrial, Other.

Dismiss the notification flyout with `Escape` before interacting — it overlays controls
and causes click timeouts.

### Delivery step (item listings)

After the details page, Facebook asks for delivery method and meetup preference.
Default to **Local pickup only**. Confirm any meetup, delivery, or shipping commitment
before adding it to a listing.

The last step offers to cross-post into local buy/sell **groups**. Leave these
unchecked unless the user asks — posting into communities on someone's behalf reads as
spam and is beyond "list this item".

### Facebook listings are effectively write-once

Once published, a listing's description and settings are **not reachable by automation**.
Titles and body text render from script payloads rather than the DOM, `marketplace/item/<id>`
links are absent from the seller page, Marketplace search does not surface the seller's
own listings, Share exposes no URL, and `marketplace/edit/<id>/` does not resolve for IDs
scraped out of the payloads.

Practical consequence: **get the copy right before publishing**, and if the user edits a
listing afterward, ask them to paste the final text rather than trying to read it back.
Post-publish changes are a manual job for the user — the path is Marketplace → Your
listings → tap the listing → Edit.

### Photo ordering

The first photo is the thumbnail and does most of the selling. Order deliberately:

1. Clean 3/4 front, whole item centered, uncluttered background
2. Both side profiles
3. **The single strongest proof point early (~#4)** — for a vehicle, the odometer if
   mileage is a selling point. It should land before someone stops scrolling.
4. Detail shots of named upgrades
5. Aspirational / in-use shots last

## Craigslist

See [`craigslist-listing.md`](craigslist-listing.md) — it has its own trap list,
including a silent category-selection failure that has put a live post in the wrong
category.

## Writing the description

Lead with what removes buyer risk: one owner, title in hand, service history. Put
provenance details ("bought new as leftover stock") lower — only if the user wants them
volunteered at all.

### Logistics commitments

Do not volunteer pickup, meetup, delivery, shipping, or travel terms on the user's
behalf. Include only commitments the user has explicitly approved, and keep them
specific to the listing.

Group upgrades under headers (PROTECTION / LUGGAGE / TOURING AND COMFORT) rather than
one long list. Name brands, and give the install cost for the expensive items so the
value reads concretely. Close with location, accepted payment, and the screening
posture ("happy to answer questions by text or video call").

If the user edits the copy after you draft it, **read the live listing and reuse their
version** for any cross-post. Don't re-post your draft — the edits are the user's voice
and usually reflect facts you don't have.

## Cross-posting

The same spec should feed Facebook Marketplace, Craigslist, and category-specific
forums. Keep one source-of-truth description; adapt only formatting (Craigslist accepts
limited HTML, Facebook is plain text).
