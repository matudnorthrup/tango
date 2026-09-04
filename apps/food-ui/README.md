# Tango Food (`@tango/food-ui`)

Food tracker & meal planner UI over the per-profile `wellness.db` — ingredients
with retail prices, gram-normalized recipes (including nested component
recipes), per-meal-serving weekly plans, generated shopping lists, and price
trends. Spec: [`docs/specs/food-tracker.md`](../../docs/specs/food-tracker.md).

## Pages

- **Ingredients** — product catalog with macros/serving and price-per-serving;
  each row opens a detail page (listings, price history, manual price entry,
  used-in recipes).
- **Recipes** — per-serving macro + cost rollups from gram quantities;
  component recipes (batch `yield_g`) usable by the gram in other recipes.
- **Planner** — weekly plans with **per-meal servings** (a school-day lunch is
  ×1 while dinner is ×2); create plans, add meals, adjust portions inline.
- **Shopping list** — plan servings × grams, rounded up to whole containers,
  priced. Meals drive the list; there is no pantry model.
- **Trends** — price movers, scan status, coverage; charts activate as scan
  history accumulates.

## Architecture

- Client: Vite + React 19, single-page tab app, hand-rolled CSS (electric
  indigo/cyan theme, light + dark), built to `dist/client`.
- Server: Hono on `@hono/node-server` (`server/`), built to `dist/server`.
  Serves the client and a JSON API over `node:sqlite`.
- Database: the profile `wellness.db`
  (`~/.tango/profiles/<profile>/wellness/wellness.db`). The Tango bot owns
  schema migrations (`ensureWellnessDb`); this server requires schema v2+ and
  fails fast with instructions otherwise. Agent writes (meal logs, products)
  and UI writes (plans, prices) go to the same store — WAL + busy_timeout
  handle the cross-process access.

## Running

```bash
npm run build -w @tango/food-ui
npm run food-ui:start      # tmux window tango:food-ui, port 9360
npm run food-ui:status
npm run food-ui:restart    # rebuilds first
```

Env: `FOOD_UI_PORT` (9360), `FOOD_UI_HOST` (127.0.0.1), `FOOD_UI_BASE_PATH`
(`/tango-food`), `FOOD_UI_TOKEN` (optional bearer auth),
`FOOD_UI_DB_PATH`/`WELLNESS_DB_PATH` (DB override). Reboot-safe via the
`food-ui` service block in `config/defaults/startup.yaml`.

## Tailscale

```bash
tailscale serve --bg --set-path /tango-food http://127.0.0.1:9360
```

Serves at `https://mac-studio.<tailnet>.ts.net/tango-food/`. The server binds
loopback only and strips the base path itself, so direct localhost access
works the same. Tailnet membership is the trust boundary (house convention).

## Dev

```bash
npm run dev:server -w @tango/food-ui   # API on 9360
npm run dev -w @tango/food-ui          # Vite on 5173, proxies /api
```
