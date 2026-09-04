# Food Tracker & Meal Planner — Spec v1

Status: draft for review (2026-09-03)
Owner: Devin (stakeholder) / active PM agent
Linear: Food Tracker & Meal Planner project (Seaside HQ / TGO)

## 1. Goal

Recreate — and automate — the three-database Notion system Devin previously ran
by hand: ingredients linked to retail products, recipes composed from
ingredients, and meal plans composed from recipes, with cost and macro rollups
at every level. Concretely:

- Track individual ingredients: serving size, grams-per-serving normalization,
  calories, protein, carbs, fat, **fiber**.
- Link each ingredient to the retail product(s) it is bought as (Walmart
  primary, Amazon secondary): container price, servings per container, and the
  derived **price per serving**.
- Compose ingredients into recipes with gram quantities; roll up per-serving
  macros **and cost**.
- Compose recipes into day-level meal plans; roll up cost per day per person
  and macro totals; generate a shopping list (containers to buy, priced).
- Keep prices fresh automatically: a weekly scheduled re-scan of Walmart
  product pages.
- Verify that what gets logged to FatSecret matches the recipes we planned.
- Host a visual UI on the Mac Studio tailnet alongside Tango Lift and Kilo.

In Notion, join tables and per-row formulas existed because Notion databases
can't aggregate across relations. A real database replaces all of that with
schema + views.

## 2. Architecture summary

One store, four surfaces:

```
                    ┌─────────────────────────────────────────┐
                    │  wellness.db (profile SQLite, WAL)      │
                    │  products / listings / price_history    │
                    │  recipes / recipe_ingredients           │
                    │  meal_plans / meal_plan_entries         │
                    │  meal_log (existing)                    │
                    └───────┬───────────┬───────────┬─────────┘
   FatSecret API            │           │           │
   (nutrition source ───────┤           │           │
    of record, food_id/     │           │           │
    serving_id mapping)     │           │           │
                            │           │           │
              ┌─────────────┴──┐  ┌─────┴───────┐  ┌┴──────────────────┐
              │ wellnessdb_*   │  │ apps/food-ui│  │ walmart-price-scan│
              │ MCP tools      │  │ :9350       │  │ weekly scheduler  │
              │ (agents, bot)  │  │ /tango-food │  │ handler (bot)     │
              └────────────────┘  └─────────────┘  └───────────────────┘
```

Decisions (each grounded in an existing repo precedent):

1. **`wellness.db` is the food source of truth.** The schema, 24 governed
   `wellnessdb_*` MCP tools, worker grants, and skills already exist in this
   repo (`packages/discord/src/wellness-db-tools.ts`) but the DB was never
   materialized on disk. We finish it rather than build a parallel store.
   Rejected alternatives: legacy `~/atlas/atlas.db` (outside the repo, frozen,
   88 drifting rows — becomes a one-time migration source); Atlas Memory (no
   typed schema; similarity retrieval is wrong for a catalog); State entities
   (spec §2 non-goals — catalogs are not volatile current-value facts);
   a new Postgres DB (splits food data across two stores when meal_log and
   recipes are already SQLite-modeled).
2. **FatSecret stays the nutrition source of record.** Products carry
   `fatsecret_food_id`/`fatsecret_serving_id` and macros are audited against
   FatSecret (the `audit-nutrition-catalog.ts` pattern), not scraped from
   Walmart labels. Walmart nutrition rendering is unreliable (label images,
   missing fields) and nutrition rarely changes; price changes weekly. The two
   belong on different cadences and different sources.
3. **Price is a time series, not a column.** A weekly deterministic scheduler
   job drives the existing Brave/CDP browser stack over each product's Walmart
   page and appends to `price_history`. "Current price" is the latest
   observation, so trends come free.
4. **The UI follows the workout-ui pattern exactly.** `apps/food-ui`,
   Vite + React + Hono, loopback port **9350**, tailscale-serve path mount
   **`/tango-food`**, tmux window + `startup.yaml` block, card on the home
   directory page.
5. **Shopping lists bridge into Foxtrot's existing Walmart queue** rather than
   inventing a new purchase path.

## 3. Schema changes (wellness.db v2)

Follow the workout-ui migration convention: idempotent SQL in
`packages/discord/sql/wellness-v2-migration.sql` applied by a versioned
runner (`PRAGMA user_version`), invoked from the same code path that
materializes the DB.

**Materialization:** call `createWellnessDbSchema()` + migrations at bot
startup when the DB file is absent (mirror `installStateTypePacks` in
`packages/discord/src/main.ts`), and from the food-ui server on boot, so
either process can bring the store up.

### 3.1 Extend existing tables

```sql
ALTER TABLE products ADD COLUMN fiber_g REAL;
ALTER TABLE products ADD COLUMN fatsecret_food_id TEXT;
ALTER TABLE products ADD COLUMN fatsecret_serving_id TEXT;
ALTER TABLE products ADD COLUMN grams_per_serving REAL;

ALTER TABLE recipes ADD COLUMN total_fiber_g REAL;
ALTER TABLE recipes ADD COLUMN yield_g REAL;        -- batch output grams (component recipes)

ALTER TABLE recipe_ingredients ADD COLUMN quantity_g REAL;  -- canonical grams
ALTER TABLE recipe_ingredients ADD COLUMN fiber_g REAL;
ALTER TABLE recipe_ingredients ADD COLUMN sub_recipe_id INTEGER REFERENCES recipes(id);
```

**Nested (component) recipes.** A recipe that is really a reusable component
— a lime crema, a spice blend, a dressing — sets `yield_g` (grams one batch
produces) and is then usable *by the gram* inside other recipes via
`recipe_ingredients.sub_recipe_id` (set instead of `product_id`). Per-gram
macros and cost are batch totals ÷ `yield_g`, so repricing an ingredient of
the component reprices every recipe that uses it. Rollups recurse in
application code (`recalculateRecipeTotals` + UI), which rejects cycles at
write time; nesting depth is unbounded in schema, practically 2–3 levels.
FatSecret logging expansion recurses the same way — a component contributes
its ingredients' FatSecret servings scaled by the grams used.

`quantity_g` is the normalization Devin asked for: free-text `quantity` stays
for display ("1 can"), `quantity_g` drives all math. For products with
`grams_per_serving`, macro contributions are computed per gram — the same
per-gram normalization `audit-nutrition-catalog.ts` already uses.

### 3.2 New tables

```sql
CREATE TABLE product_listings (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  retailer TEXT NOT NULL CHECK(retailer IN ('walmart','amazon')),
  retailer_item_id TEXT,          -- Walmart /ip/<slug>/<itemId>, Amazon ASIN
  url TEXT,
  package_description TEXT,       -- "15.5 oz can", "2 lb bag"
  package_grams REAL,             -- total net grams in the container
  servings_per_container REAL,
  active INTEGER NOT NULL DEFAULT 1,
  preferred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE price_history (
  id INTEGER PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES product_listings(id),
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  price REAL NOT NULL,            -- container price, USD
  unit_price TEXT,                -- retailer's own "¢/oz" string, verbatim
  in_stock INTEGER,
  source TEXT NOT NULL DEFAULT 'walmart-price-scan'  -- or 'manual', 'receipt'
);
CREATE INDEX idx_price_history_listing ON price_history(listing_id, observed_at);

CREATE TABLE meal_plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT,                -- NULL = reusable template
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE meal_plan_entries (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES meal_plans(id),
  day_index INTEGER NOT NULL DEFAULT 0,   -- 0-based day within the plan
  meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','snack','dinner')),
  recipe_id INTEGER REFERENCES recipes(id),
  product_id INTEGER REFERENCES products(id),
  servings REAL NOT NULL DEFAULT 1.0   -- total portions AT THIS MEAL (see below)
);
```

**Per-meal servings, no people multiplier** (ratified 2026-09-03): who eats
varies by meal, not by week — a school-day breakfast/lunch is ×1 while
dinner is ×2 — so portion counts live on each `meal_plan_entries` row and
plan totals are absolute sums. There is deliberately **no pantry model**:
meals drive the shopping list (aggregate grams → containers, rounded up),
nothing tracks what's already on the shelf.
```sql

-- Phase 4: attribution of FatSecret diary entries back to recipes
CREATE TABLE fatsecret_entry_links (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  meal TEXT,
  recipe_id INTEGER REFERENCES recipes(id),
  food_entry_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 3.3 Views (the Notion formulas, done properly)

- `product_current_price` — latest `price_history` row per preferred active
  listing; derives `price_per_serving = price / servings_per_container` and
  `price_per_gram = price / package_grams`.
- `recipe_summary` (replaced) — adds `per_serving_fiber` and
  `per_serving_cost` (sum over ingredients of `quantity_g × price_per_gram`,
  falling back to serving-based pricing when `package_grams` is null).
- `plan_summary` — per plan/day: total portions, cost, calories, protein,
  fiber, fat (absolute sums over per-meal servings).
- `shopping_list` — per plan: aggregate `quantity_g × servings` across all
  entries, divide by `package_grams`, round containers up, price the result.

Rollup columns on `recipes` (`total_*`) remain and
`recalculateRecipeTotals()` is extended to fiber and to prefer per-gram math
via `quantity_g`.

## 4. Data migration

One-time script `scripts/migrate-atlas-ingredients.ts`:

- Read the 88 rows from `~/atlas/atlas.db` `ingredients`
  (`name, brand, product, food_id, serving_id, serving_description,
  grams_per_serving, calories, protein, carbs, fat, fiber, store, …`).
- Upsert into `products` (macros, fiber, FatSecret IDs, grams_per_serving;
  `source='atlas-migration'`), creating a `product_listings` stub
  (retailer from `store`, item ID empty) for each.
- Run `npm run diag:nutrition-catalog` semantics against the *new* rows before
  declaring done (reuse the audit's per-gram comparator).
- `~/atlas/atlas.db` is then frozen: read-only for Malibu until Phase 4
  retargets `nutrition-log-executor.ts`'s Atlas lookup at `wellness.db`.

**Recipe notes** (ratified 2026-09-03): the ~28 markdown recipe notes are
imported once via `scripts/import-recipe-notes.ts` (frontmatter macros,
gram-annotated ingredient lines → `recipes` + `recipe_ingredients` with
`quantity_g`); wellness.db becomes the **canonical** recipe store. At the
same deploy, flows that reference the markdown notes — `recipe_read`/
`recipe_write`/`recipe_list` tools, `agents/skills/recipe-management.md`,
`food-logging.md`, Malibu/Jules knowledge — are retargeted at the
`wellnessdb_*` tools; the notes stay on disk as a frozen archive.

Walmart item-ID backfill is interactive-ish work the agent does once: for each
product, find the canonical `/ip/<slug>/<itemId>` URL (browser session already
logged in) and fill `product_listings.retailer_item_id`, `package_grams`, and
`servings_per_container` from the product page. This is the prerequisite for
the weekly scan.

## 5. Weekly Walmart price scan

- Handler: `packages/discord/src/walmart-price-scan.ts`, a
  `DeterministicHandler` modeled on `printer-monitor.ts`, registered in
  `main.ts` beside `browser-session-keepalive`.
- Schedule: `config/defaults/schedules/walmart-price-scan.yaml` — weekly cron
  (Sunday early AM), `execution.mode: deterministic`,
  `completion.scope: weekly`, backoff enabled, and a
  `policy.concurrency_group` shared with the other browser jobs (Foxtrot's
  knowledge file forbids overlapping browser-heavy flows).
- Mechanics: `getBrowserManager()` + `pageForOrigin("https://www.walmart.com")`
  (pinned Tango-owned tab); for each active walmart listing, load the PDP and
  `page.evaluate` the `__NEXT_DATA__` JSON; extract price, availability, unit
  price. 3–5 s randomized pacing → ~5–10 min for 100 items, inside a 900 s
  timeout.
- Robustness: version the `__NEXT_DATA__` parser; if the null-rate in a run
  spikes, return `status: "error"` with a summary instead of writing zeros
  (the scheduler's `alertChannelId` surfaces it). Verify the store selector
  matches the configured home store before trusting prices. Empty watch list
  → `status: "skipped"`, matching the keepalive convention.
- Amazon: **no scheduled scraping in v1** (heavier bot detection, fewer
  items). Amazon listings get manual price entry in the UI
  (`price_history.source='manual'`); revisit a scheduled scan only if manual
  upkeep is annoying in practice.
- Receipt cross-feed (later, optional): Foxtrot's receipt parser already
  computes per-item average prices; observed purchase prices can append to
  `price_history` with `source='receipt'`.

## 6. Food UI (`apps/food-ui`)

Copy the workout-ui shape wholesale: workspace `@tango/food-ui`, Vite + React
19 + Tailwind v4 + TanStack Query client (`base: '/tango-food/'`), Hono server
on `127.0.0.1:9350` (`FOOD_UI_PORT/HOST/BASE_PATH` envs, base-path shim and
loopback-only bind copied from `apps/workout-ui/server/main.ts`).

DB access: `node:sqlite` on the profile `wellness.db` (WAL, busy_timeout
5000). The state-management spec's "one writer process" rule is noted and
deliberately relaxed here: the bot writes `meal_log`/`products` via agent
tools, the UI writes catalog/recipe/plan tables; WAL with short transactions
handles cross-process writers safely. If contention or lock errors ever
appear, the fallback is the tango-state pattern (UI writes proxied through a
thin bot-hosted HTTP API); the UI's data layer should be one module so that
swap is cheap.

Pages (shape validated via interactive mockup with Devin, 2026-09-03).
Universal convention: **every ingredient or recipe name, anywhere in the app,
is a link to that entity's page** — recipe ingredient rows, planner slots,
shopping-list rows, trend movers, used-in lists. No dead entity names.

Pages (shape validated via interactive mockup with Devin, 2026-09-03):

1. **Ingredients** — table of products with full macros/serving (calories,
   protein, **fat**, fiber), grams/serving, current price, price/serving,
   freshness badge (>14 days stale). Each row opens a **detail page**: full
   macro panel (incl. carbs), FatSecret mapping + audit status, all listings
   (preferred + alternates, $/container comparison), the item's price-history
   chart, manual price entry for Amazon listings, used-in-recipes list with
   per-recipe cost contribution, and a re-scan action. Item-level price
   history lives here, not on a separate page.
2. **Recipes** — ingredient rows (grams + display quantity), live per-serving
   macro/cost rollup while editing; flag ingredients with no price or no
   FatSecret mapping (cost shown as a floor when any ingredient is unpriced).
3. **Planner** — day grid of meal slots filled from recipes; per-day cost,
   cost/person, calories/protein/fiber/fat vs. simple targets.
4. **Shopping list** — per plan: containers to buy with prices and total;
   button to push items into Foxtrot's Walmart queue (Phase 4);
   pantry-exclusion for staples that haven't run out.
5. **Trends** — the "is this working?" page (replaces the earlier flat
   Prices page, which duplicated the ingredient list at item level):
   weekly grocery spend vs. budget target, spend/person/day vs. planned
   cost/person/day, average cost per meal by slot, protein/fiber
   per-person-per-day weekly trends vs. targets, biggest price movers from
   the last scan, and the scan status line (items read/skipped, store
   verification). Sources: `price_history`, `meal_log`, `plan_summary`.

Live refresh: v1 polls with TanStack Query staleness (SQLite has no
`pg_notify`); SSE only if it earns its keep later.

Hosting checklist (house pattern): tmux scripts
`scripts/tmux/food-ui-{start,stop,restart,status}.sh`, root npm aliases,
`config/defaults/startup.yaml` block with `tcp 127.0.0.1:9350` health check,
`tailscale serve --bg --set-path /tango-food http://127.0.0.1:9350` (manual,
one-time — also added to the Obsidian post-outage checklist), card in
`apps/home/index.html`, README in workout-ui's section order. Wire the app
into root `build`/`test` chains (kilo-style) so CI compiles it.

## 7. Agent integration

- **Malibu gets first-class visibility** (ratified 2026-09-03): Malibu keeps
  logging to FatSecret, but reads recipes/products from wellness.db — grant
  the `wellnessdb_*` read tools (and recipe tools) to Malibu alongside the
  existing Jules/cod-e grants, and keep `fatsecret_food_id`/`serving_id` on
  every product so the DB, the diary, and the planner stay one tracked
  system.
- **Tools:** the 24 `wellnessdb_*` tools already cover product/recipe/meal
  CRUD. Add narrow tools (per `docs/guides/adding-tools.md`) for the new
  surfaces: `wellnessdb_price_status` (current price + staleness per
  product), `wellnessdb_plan_summary`, `wellnessdb_shopping_list`. Governance
  trap (TGO-737): every new tool needs the `governance_tools` seed **and**
  grants **and** agent-YAML `ALLOWED_TOOL_IDS`, including `-ollama` clones —
  three places, silent failure if any is missed.
- **Source-of-truth wiring:** point `state-memory-supersession` at the
  recipe/ingredient domain so stale Atlas Memory chunks of old recipe notes
  get archived once `wellness.db` owns them; surface canonical values through
  the existing turn-briefing digest path rather than trusting memory recall.
- **No raw SQL to models** (`docs/architecture/deterministic-vs-ai-boundaries.md`):
  everything goes through the narrow `wellnessdb_*` tools; `atlas_sql` is the
  named anti-pattern and retires with the legacy DB.

## 8. FatSecret verification (Phase 4)

Goal: confidence that FatSecret logging matches planned recipes.

- **Attribution:** when `nutrition_log_items` writes diary entries from a
  recipe expansion, record `(date, meal, recipe_id, food_entry_id)` in
  `fatsecret_entry_links` (the executor already holds both sides at write
  time).
- **Verification job/tool:** for a given day, read `food_entries_get`, join
  linked entries to recipes, and compare logged macros against
  `recipe_summary` per-serving targets using the audit script's per-gram
  comparator and tolerance style (looser bands for fiber/carbs — FatSecret
  community entries often report 0). Surface mismatches in the UI planner
  view and via a `wellnessdb_*` read tool.
- Custom-food push to FatSecret is **out of scope**: `food.create` is a
  Premier-tier API and pyfatsecret doesn't expose it. Recipes stay local;
  FatSecret remains a diary we write to and verify against.

## 9. Phases

1. **Foundation** — materialize wellness.db, v2 migration, atlas.db
   ingredient migration + audit, Walmart item-ID/servings backfill.
2. **Food UI** — `apps/food-ui` with Ingredients/Recipes/Planner/Shopping
   list/Prices, hosted at `/tango-food` (9350), reboot-safe.
3. **Automation** — weekly Walmart price scan + staleness surfacing; manual
   Amazon entry.
4. **Integration** — FatSecret verification loop, shopping-list → Foxtrot
   Walmart queue, memory supersession, retire `atlas_sql`/legacy DB
   (retarget `nutrition-log-executor` at wellness.db).
5. **Validation & ship** — live end-to-end: real week planned, scanned,
   shopped, logged, verified.

## 10. Decisions log

Ratified by Devin 2026-09-03 (see TGO-851 for the full list with leans):
ingredient rows are state-specific (cooked-as-prepared, e.g. shredded
chicken with juices); per-meal servings, no people multiplier; **no pantry
tracking — meals drive the shopping list**; planner never writes to
FatSecret (Malibu logs; verification compares after the fact); recipe
notes import once and wellness.db is canonical; Malibu gets wellnessdb
read access.

Remaining defaults (non-blocking):

1. Fixed home Walmart store assumed (prices are store-scoped); scan asserts
   the signed-in session's store.
2. Price staleness threshold: 14 days for the UI badge.
3. Weekly scan time: Sunday 05:30 (quiet, pre-deep-work).
4. Named per-person macro targets (Devin vs Kalepo) are the expected v2 of
   the planner; per-meal servings keep the schema compatible.
