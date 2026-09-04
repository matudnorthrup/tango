import { Hono } from 'hono';
import { all, one, run } from './db.js';

export const api = new Hono();

api.get('/health', (c) => c.json({ ok: true }));

// ---------- products ----------

api.get('/products', (c) => {
  const showAll = c.req.query('all') === '1';
  const products = all(`
    SELECT p.id, p.name, p.brand, p.category, p.serving_size, p.grams_per_serving,
           p.calories, p.protein_g, p.carbs_g, p.fat_g, p.fiber_g,
           p.fatsecret_food_id, p.discontinued_date,
           pp.retailer, pp.price, pp.observed_at, pp.price_per_serving, pp.price_per_gram,
           (SELECT count(*) FROM product_listings pl WHERE pl.product_id = p.id AND pl.active = 1) AS listing_count
    FROM products p
    LEFT JOIN product_price pp ON pp.product_id = p.id
    ${showAll ? '' : 'WHERE p.discontinued_date IS NULL'}
    ORDER BY p.name
  `);
  return c.json({ products });
});

api.get('/products/:id', (c) => {
  const id = Number(c.req.param('id'));
  const product = one('SELECT * FROM products WHERE id = ?', [id]);
  if (!product) return c.json({ error: 'not found' }, 404);
  const listings = all(
    `
    SELECT pl.id, pl.retailer, pl.retailer_item_id, pl.url, pl.package_description,
           pl.package_grams, pl.servings_per_container, pl.active, pl.preferred,
           pcp.price, pcp.observed_at, pcp.price_per_serving, pcp.price_per_gram, pcp.in_stock
    FROM product_listings pl
    LEFT JOIN product_current_price pcp ON pcp.listing_id = pl.id
    WHERE pl.product_id = ?
    ORDER BY pl.preferred DESC, pl.id
  `,
    [id],
  );
  const history = all(
    `
    SELECT ph.listing_id, ph.observed_at, ph.price, ph.in_stock, ph.source
    FROM price_history ph
    JOIN product_listings pl ON pl.id = ph.listing_id
    WHERE pl.product_id = ?
    ORDER BY ph.observed_at DESC
    LIMIT 120
  `,
    [id],
  );
  const usedIn = all(
    `
    SELECT r.id AS recipe_id, r.name, ri.quantity, ri.quantity_g, r.servings,
           rs.per_serving_cost
    FROM recipe_ingredients ri
    JOIN recipes r ON r.id = ri.recipe_id
    LEFT JOIN recipe_summary rs ON rs.id = r.id
    WHERE ri.product_id = ?
    ORDER BY r.name
  `,
    [id],
  );
  return c.json({ product, listings, history, usedIn });
});

api.post('/listings/:id/price', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ price?: number }>();
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0 || price > 10000) {
    return c.json({ error: 'price must be a positive number' }, 400);
  }
  const listing = one('SELECT id FROM product_listings WHERE id = ?', [id]);
  if (!listing) return c.json({ error: 'listing not found' }, 404);
  run("INSERT INTO price_history (listing_id, price, source) VALUES (?, ?, 'manual')", [id, price]);
  return c.json({ ok: true });
});

// ---------- recipes ----------

api.get('/recipes', (c) => {
  const showAll = c.req.query('all') === '1';
  const recipes = all(`
    SELECT rs.*, r.yield_g, r.archived_at,
           (SELECT count(*) FROM recipe_ingredients ri WHERE ri.recipe_id = rs.id) AS ingredient_count
    FROM recipe_summary rs
    JOIN recipes r ON r.id = rs.id
    ${showAll ? '' : 'WHERE r.archived_at IS NULL'}
    ORDER BY rs.name
  `);
  return c.json({ recipes });
});

// Archive = retire without deleting; history, plans, and links stay intact.
api.post('/recipes/:id/archive', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ archived?: boolean }>().catch(() => ({ archived: true }));
  run(body.archived === false ? 'UPDATE recipes SET archived_at = NULL WHERE id = ?' : "UPDATE recipes SET archived_at = datetime('now') WHERE id = ?", [id]);
  return c.json({ ok: true });
});

api.post('/products/:id/archive', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ archived?: boolean }>().catch(() => ({ archived: true }));
  run(body.archived === false ? 'UPDATE products SET discontinued_date = NULL, discontinued_reason = NULL WHERE id = ?' : "UPDATE products SET discontinued_date = date('now'), discontinued_reason = 'archived from Tango Food' WHERE id = ?", [id]);
  return c.json({ ok: true });
});

api.get('/recipes/:id', (c) => {
  const id = Number(c.req.param('id'));
  const recipe = one(
    'SELECT rs.*, r.yield_g, r.archived_at FROM recipe_summary rs JOIN recipes r ON r.id = rs.id WHERE rs.id = ?',
    [id],
  );
  if (!recipe) return c.json({ error: 'not found' }, 404);
  const ingredients = all(
    `
    SELECT ri.id, ri.ingredient_name, ri.quantity, ri.quantity_g, ri.calories, ri.protein_g,
           ri.fiber_g, ri.product_id, ri.sub_recipe_id,
           p.name AS product_name,
           sr.name AS sub_recipe_name,
           CASE WHEN ri.quantity_g IS NOT NULL AND pp.price_per_gram IS NOT NULL
                THEN ROUND(ri.quantity_g * pp.price_per_gram, 2) END AS cost
    FROM recipe_ingredients ri
    LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    LEFT JOIN product_price pp ON pp.product_id = ri.product_id
    WHERE ri.recipe_id = ?
    ORDER BY ri.calories DESC
  `,
    [id],
  );
  const usedIn = all(
    `
    SELECT r.id AS recipe_id, r.name, ri.quantity_g
    FROM recipe_ingredients ri
    JOIN recipes r ON r.id = ri.recipe_id
    WHERE ri.sub_recipe_id = ?
    ORDER BY r.name
  `,
    [id],
  );
  return c.json({ recipe, ingredients, usedIn });
});

// ---------- plans ----------

api.get('/plans', (c) => {
  const plans = all(`
    SELECT mp.id, mp.name, mp.start_date, mp.created_at,
           (SELECT count(*) FROM meal_plan_entries e WHERE e.plan_id = mp.id) AS entry_count,
           (SELECT ROUND(SUM(ps.cost_total), 2) FROM plan_summary ps WHERE ps.plan_id = mp.id) AS cost_total
    FROM meal_plans mp
    ORDER BY mp.created_at DESC
  `);
  return c.json({ plans });
});

api.post('/plans', async (c) => {
  const body = await c.req.json<{ name?: string; start_date?: string }>();
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const startDate = body.start_date && /^\d{4}-\d{2}-\d{2}$/.test(body.start_date) ? body.start_date : null;
  const id = run('INSERT INTO meal_plans (name, start_date) VALUES (?, ?)', [name, startDate]);
  return c.json({ id });
});

api.get('/plans/:id', (c) => {
  const id = Number(c.req.param('id'));
  const plan = one('SELECT * FROM meal_plans WHERE id = ?', [id]);
  if (!plan) return c.json({ error: 'not found' }, 404);
  const entries = all(
    `
    SELECT e.id, e.day_index, e.meal, e.servings, e.recipe_id, e.product_id,
           COALESCE(r.name, p.name) AS name,
           COALESCE(rs.per_serving_cal, p.calories) AS per_serving_cal,
           COALESCE(rs.per_serving_prot, p.protein_g) AS per_serving_prot,
           COALESCE(rs.per_serving_cost, pp.price_per_serving) AS per_serving_cost
    FROM meal_plan_entries e
    LEFT JOIN recipes r ON r.id = e.recipe_id
    LEFT JOIN recipe_summary rs ON rs.id = e.recipe_id
    LEFT JOIN products p ON p.id = e.product_id
    LEFT JOIN product_price pp ON pp.product_id = e.product_id
    WHERE e.plan_id = ?
    ORDER BY e.day_index, CASE e.meal WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 WHEN 'snack' THEN 2 ELSE 3 END
  `,
    [id],
  );
  const days = all('SELECT * FROM plan_summary WHERE plan_id = ? ORDER BY day_index', [id]);
  const shopping = all('SELECT * FROM shopping_list WHERE plan_id = ? ORDER BY grams_needed DESC', [id]);
  return c.json({ plan, entries, days, shopping });
});

api.post('/plans/:id/entries', async (c) => {
  const planId = Number(c.req.param('id'));
  if (!one('SELECT id FROM meal_plans WHERE id = ?', [planId])) return c.json({ error: 'plan not found' }, 404);
  const body = await c.req.json<{
    day_index?: number;
    meal?: string;
    recipe_id?: number;
    product_id?: number;
    servings?: number;
  }>();
  const meal = String(body.meal ?? '');
  if (!['breakfast', 'lunch', 'snack', 'dinner'].includes(meal)) return c.json({ error: 'bad meal' }, 400);
  const dayIndex = Number(body.day_index ?? 0);
  const servings = Number(body.servings ?? 1);
  const recipeId = body.recipe_id ? Number(body.recipe_id) : null;
  const productId = body.product_id ? Number(body.product_id) : null;
  if (!recipeId && !productId) return c.json({ error: 'recipe_id or product_id required' }, 400);
  const id = run(
    'INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, product_id, servings) VALUES (?, ?, ?, ?, ?, ?)',
    [planId, dayIndex, meal, recipeId, productId, servings],
  );
  return c.json({ id });
});

api.patch('/entries/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ servings?: number }>();
  const servings = Number(body.servings);
  if (!Number.isFinite(servings) || servings < 0 || servings > 24) return c.json({ error: 'bad servings' }, 400);
  run('UPDATE meal_plan_entries SET servings = ? WHERE id = ?', [servings, id]);
  return c.json({ ok: true });
});

api.delete('/entries/:id', (c) => {
  run('DELETE FROM meal_plan_entries WHERE id = ?', [Number(c.req.param('id'))]);
  return c.json({ ok: true });
});

// ---------- trends ----------

api.get('/trends', (c) => {
  const movers = all(`
    SELECT p.id AS product_id, p.name, cur.price AS now_price, prev.price AS was_price,
           cur.observed_at,
           ROUND((cur.price - prev.price) / prev.price * 100, 1) AS delta_pct
    FROM product_listings pl
    JOIN products p ON p.id = pl.product_id
    JOIN price_history cur ON cur.id = (
      SELECT id FROM price_history WHERE listing_id = pl.id ORDER BY observed_at DESC, id DESC LIMIT 1)
    JOIN price_history prev ON prev.id = (
      SELECT id FROM price_history WHERE listing_id = pl.id ORDER BY observed_at DESC, id DESC LIMIT 1 OFFSET 1)
    WHERE cur.price != prev.price
    ORDER BY ABS(cur.price - prev.price) / prev.price DESC
    LIMIT 10
  `);
  const scan = one<{ last_scan: string | null; observations: number }>(`
    SELECT MAX(observed_at) AS last_scan, count(*) AS observations
    FROM price_history WHERE source != 'manual'
  `);
  const coverage = one<{ priced: number; listings: number; products: number }>(`
    SELECT
      (SELECT count(DISTINCT listing_id) FROM price_history) AS priced,
      (SELECT count(*) FROM product_listings WHERE active = 1) AS listings,
      (SELECT count(*) FROM products) AS products
  `);
  return c.json({ movers, scan, coverage });
});
