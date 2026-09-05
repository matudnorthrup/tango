import { Hono } from 'hono';
import { all, getDb, one, run } from './db.js';

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
           CASE WHEN r.yield_g > 0 THEN ROUND(r.total_calories * 100.0 / r.yield_g) END AS per_100g_cal,
           CASE WHEN r.yield_g > 0 THEN ROUND(r.total_protein_g * 100.0 / r.yield_g, 1) END AS per_100g_prot,
           CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fat_g * 100.0 / r.yield_g, 1) END AS per_100g_fat,
           CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fiber_g * 100.0 / r.yield_g, 1) END AS per_100g_fiber,
           CASE WHEN r.yield_g > 0 THEN ROUND(rc.total_cost * 100.0 / r.yield_g, 2) END AS per_100g_cost,
           (SELECT count(*) FROM recipe_ingredients ri WHERE ri.recipe_id = rs.id) AS ingredient_count,
           -- searchable text for the recipes table: every row's display name plus the linked
           -- product / component name, and the recipe's aliases
           (SELECT group_concat(DISTINCT COALESCE(p.name, sr.name, ri.ingredient_name))
              FROM recipe_ingredients ri
              LEFT JOIN products p ON p.id = ri.product_id
              LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
             WHERE ri.recipe_id = rs.id) AS ingredient_names,
           (SELECT group_concat(DISTINCT ri.ingredient_name) FROM recipe_ingredients ri WHERE ri.recipe_id = rs.id) AS ingredient_labels,
           (SELECT group_concat(alias, ', ') FROM recipe_aliases ra WHERE ra.recipe_id = rs.id) AS aliases,
           (SELECT count(*) FROM recipe_ingredients ri WHERE ri.recipe_id = rs.id AND ri.sub_recipe_id IS NOT NULL) AS component_count
    FROM recipe_summary rs
    JOIN recipes r ON r.id = rs.id
    LEFT JOIN recipe_cost rc ON rc.recipe_id = rs.id
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

// ---------- recipe editing ----------

type Macros = {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
};

type RecipeRow = {
  id: number;
  name: string;
  shorthand: string | null;
  servings: number | null;
  yield_g: number | null;
  instructions: string | null;
  notes: string | null;
  archived_at: string | null;
};

function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Recompute and store one row's macros from its product (per grams_per_serving)
// or its component recipe (per yield_g). Stored values win on every read path,
// so any write that changes grams or the underlying basis must go through here.
function refreshRowMacros(rowId: number): void {
  const derived = one<Macros & { quantity_g: number | null; basis: number | null }>(
    `
    SELECT ri.quantity_g,
           CASE WHEN ri.product_id IS NOT NULL THEN NULLIF(p.grams_per_serving, 0) ELSE NULLIF(sr.yield_g, 0) END AS basis,
           ROUND(ri.quantity_g * COALESCE(p.calories * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0))) AS calories,
           ROUND(ri.quantity_g * COALESCE(p.protein_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_protein_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS protein_g,
           ROUND(ri.quantity_g * COALESCE(p.carbs_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_carbs_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS carbs_g,
           ROUND(ri.quantity_g * COALESCE(p.fat_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_fat_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS fat_g,
           ROUND(ri.quantity_g * COALESCE(p.fiber_g * 1.0 / NULLIF(p.grams_per_serving, 0),
                                          sr.total_fiber_g * 1.0 / NULLIF(sr.yield_g, 0)), 1) AS fiber_g
    FROM recipe_ingredients ri
    LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    WHERE ri.id = ?
  `,
    [rowId],
  );
  // No grams, or no basis to scale by (product without grams_per_serving,
  // component without yield): leave whatever was stored alone.
  if (!derived || derived.quantity_g == null || derived.basis == null) return;
  run(
    'UPDATE recipe_ingredients SET calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, fiber_g = ? WHERE id = ?',
    [derived.calories, derived.protein_g, derived.carbs_g, derived.fat_g, derived.fiber_g, rowId],
  );
}

// Mirrors recalculateRecipeTotals in @tango/discord wellness-db-tools: stored
// per-row macros win, rows carrying only grams derive from product/component.
function recalculateRecipeTotals(recipeId: number): void {
  const totals = one<Macros>(
    `
    SELECT
      COALESCE(SUM(COALESCE(ri.calories, ri.quantity_g * p.calories * 1.0 / NULLIF(p.grams_per_serving, 0),
        ri.quantity_g * sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS calories,
      COALESCE(SUM(COALESCE(ri.protein_g, ri.quantity_g * p.protein_g * 1.0 / NULLIF(p.grams_per_serving, 0),
        ri.quantity_g * sr.total_protein_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS protein_g,
      COALESCE(SUM(COALESCE(ri.carbs_g, ri.quantity_g * p.carbs_g * 1.0 / NULLIF(p.grams_per_serving, 0),
        ri.quantity_g * sr.total_carbs_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS carbs_g,
      COALESCE(SUM(COALESCE(ri.fat_g, ri.quantity_g * p.fat_g * 1.0 / NULLIF(p.grams_per_serving, 0),
        ri.quantity_g * sr.total_fat_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS fat_g,
      COALESCE(SUM(COALESCE(ri.fiber_g, ri.quantity_g * p.fiber_g * 1.0 / NULLIF(p.grams_per_serving, 0),
        ri.quantity_g * sr.total_fiber_g * 1.0 / NULLIF(sr.yield_g, 0))), 0) AS fiber_g
    FROM recipe_ingredients ri
    LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    WHERE ri.recipe_id = ?
  `,
    [recipeId],
  );
  const tenth = (v: number | null) => Math.round((v ?? 0) * 10) / 10;
  run(
    `UPDATE recipes
     SET total_calories = ?, total_protein_g = ?, total_carbs_g = ?, total_fat_g = ?, total_fiber_g = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
    [
      Math.round(totals?.calories ?? 0),
      tenth(totals?.protein_g ?? 0),
      tenth(totals?.carbs_g ?? 0),
      tenth(totals?.fat_g ?? 0),
      tenth(totals?.fiber_g ?? 0),
      recipeId,
    ],
  );
}

// A component recipe's totals or yield changed: every row in another recipe
// that uses it as a sub-recipe has stale stored macros. One level deep, which
// is as far as the read views resolve.
function cascadeComponentChange(recipeId: number): void {
  const rows = all<{ id: number; recipe_id: number }>(
    'SELECT id, recipe_id FROM recipe_ingredients WHERE sub_recipe_id = ? AND recipe_id != ?',
    [recipeId, recipeId],
  );
  for (const row of rows) refreshRowMacros(row.id);
  for (const parentId of new Set(rows.map((r) => r.recipe_id))) recalculateRecipeTotals(parentId);
}

function isComponent(recipeId: number): boolean {
  const r = one<{ yield_g: number | null }>('SELECT yield_g FROM recipes WHERE id = ?', [recipeId]);
  return r != null && r.yield_g != null && r.yield_g > 0;
}

function afterRecipeChange(recipeId: number): void {
  recalculateRecipeTotals(recipeId);
  if (isComponent(recipeId)) cascadeComponentChange(recipeId);
}

function ingredientRows(recipeId: number, rowId?: number) {
  return all(
    `
    SELECT ri.id, ri.ingredient_name, ri.quantity, ri.quantity_g,
           -- sub-recipe rows: macros derive from the component's batch totals ÷ yield × grams used
           COALESCE(ri.calories, ROUND(ri.quantity_g * p.calories * 1.0 / NULLIF(p.grams_per_serving, 0)),
                    ROUND(ri.quantity_g * sr.total_calories * 1.0 / NULLIF(sr.yield_g, 0))) AS calories,
           COALESCE(ri.protein_g, ROUND(ri.quantity_g * p.protein_g / NULLIF(p.grams_per_serving, 0), 1),
                    ROUND(ri.quantity_g * sr.total_protein_g / NULLIF(sr.yield_g, 0), 1)) AS protein_g,
           COALESCE(ri.fiber_g, ROUND(ri.quantity_g * p.fiber_g / NULLIF(p.grams_per_serving, 0), 1),
                    ROUND(ri.quantity_g * sr.total_fiber_g / NULLIF(sr.yield_g, 0), 1)) AS fiber_g,
           ri.product_id, ri.sub_recipe_id,
           p.name AS product_name,
           sr.name AS sub_recipe_name,
           CASE WHEN ri.quantity_g IS NOT NULL AND pp.price_per_gram IS NOT NULL
                THEN ROUND(ri.quantity_g * pp.price_per_gram, 2)
                WHEN ri.quantity_g IS NOT NULL AND src.total_cost IS NOT NULL AND sr.yield_g > 0
                THEN ROUND(ri.quantity_g * src.total_cost / sr.yield_g, 2) END AS cost
    FROM recipe_ingredients ri
    LEFT JOIN products p ON p.id = ri.product_id
    LEFT JOIN recipes sr ON sr.id = ri.sub_recipe_id
    LEFT JOIN recipe_cost src ON src.recipe_id = ri.sub_recipe_id
    LEFT JOIN product_price pp ON pp.product_id = ri.product_id
    WHERE ri.recipe_id = ? ${rowId != null ? 'AND ri.id = ?' : ''}
    ORDER BY 5 DESC
  `,
    rowId != null ? [recipeId, rowId] : [recipeId],
  );
}

function ingredientRow(recipeId: number, rowId: number) {
  return ingredientRows(recipeId, rowId)[0] ?? null;
}

function recipeAliases(recipeId: number): string[] {
  return all<{ alias: string }>('SELECT alias FROM recipe_aliases WHERE recipe_id = ? ORDER BY alias', [recipeId]).map(
    (r) => r.alias,
  );
}

// Same payload as GET /recipes/:id; mutation endpoints return it so the client
// can replace its state without a second round trip.
function recipeDetail(id: number) {
  const recipe = one(
    `SELECT rs.*, r.yield_g, r.archived_at,
            CASE WHEN r.yield_g > 0 THEN ROUND(r.total_calories * 100.0 / r.yield_g) END AS per_100g_cal,
            CASE WHEN r.yield_g > 0 THEN ROUND(r.total_protein_g * 100.0 / r.yield_g, 1) END AS per_100g_prot,
            CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fat_g * 100.0 / r.yield_g, 1) END AS per_100g_fat,
            CASE WHEN r.yield_g > 0 THEN ROUND(r.total_fiber_g * 100.0 / r.yield_g, 1) END AS per_100g_fiber,
            CASE WHEN r.yield_g > 0 THEN ROUND(rc.total_cost * 100.0 / r.yield_g, 2) END AS per_100g_cost
     FROM recipe_summary rs JOIN recipes r ON r.id = rs.id LEFT JOIN recipe_cost rc ON rc.recipe_id = rs.id WHERE rs.id = ?`,
    [id],
  );
  if (!recipe) return null;
  const ingredients = ingredientRows(id);
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
  return { recipe, ingredients, usedIn, aliases: recipeAliases(id) };
}

function nameTaken(name: string, exceptId?: number): boolean {
  return (
    one(
      `SELECT id FROM recipes WHERE lower(name) = lower(?) AND archived_at IS NULL ${exceptId != null ? 'AND id != ?' : ''}`,
      exceptId != null ? [name, exceptId] : [name],
    ) != null
  );
}

function replaceAliases(recipeId: number, aliases: unknown): void {
  run('DELETE FROM recipe_aliases WHERE recipe_id = ?', [recipeId]);
  insertAliases(recipeId, aliases);
}

function insertAliases(recipeId: number, aliases: unknown): void {
  if (!Array.isArray(aliases)) return;
  for (const alias of aliases) {
    const text = String(alias ?? '').trim();
    if (!text) continue;
    run('INSERT OR IGNORE INTO recipe_aliases (recipe_id, alias) VALUES (?, ?)', [recipeId, text]);
  }
}

function positiveOrNull(value: unknown): number | null | 'invalid' {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
}

function gramsLabel(quantityG: number): string {
  return `${Number.isInteger(quantityG) ? quantityG : Math.round(quantityG * 10) / 10} g`;
}

// Picker for the add-ingredient UI. Registered before /recipes/:id so "pick"
// is not swallowed as an id.
api.get('/recipes/pick', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q}%`;
  const products = q
    ? all(
        `SELECT id, name, brand, grams_per_serving, calories, protein_g
         FROM products
         WHERE discontinued_date IS NULL AND (name LIKE ? OR brand LIKE ? OR shorthand LIKE ?)
         ORDER BY name LIMIT 25`,
        [like, like, like],
      )
    : all(
        `SELECT id, name, brand, grams_per_serving, calories, protein_g
         FROM products WHERE discontinued_date IS NULL ORDER BY name LIMIT 25`,
      );
  const componentSelect = `
    SELECT r.id, r.name, r.yield_g,
           ROUND(r.total_calories * 100.0 / r.yield_g) AS per_100g_cal,
           ROUND(r.total_protein_g * 100.0 / r.yield_g, 1) AS per_100g_prot
    FROM recipes r
    WHERE r.archived_at IS NULL AND r.yield_g IS NOT NULL AND r.yield_g > 0`;
  const components = q
    ? all(
        `${componentSelect}
           AND (r.name LIKE ? OR r.shorthand LIKE ?
                OR EXISTS (SELECT 1 FROM recipe_aliases ra WHERE ra.recipe_id = r.id AND ra.alias LIKE ?))
         ORDER BY r.name LIMIT 25`,
        [like, like, like],
      )
    : all(`${componentSelect} ORDER BY r.name LIMIT 25`);
  return c.json({ products, components });
});

api.get('/recipes/:id', (c) => {
  const detail = recipeDetail(Number(c.req.param('id')));
  if (!detail) return c.json({ error: 'not found' }, 404);
  return c.json(detail);
});

api.post('/recipes', async (c) => {
  const body = await c.req.json<{
    name?: string;
    servings?: number;
    yield_g?: number | null;
    notes?: string | null;
    instructions?: string | null;
    aliases?: string[];
  }>();
  const name = String(body.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  if (nameTaken(name)) return c.json({ error: 'a recipe with that name already exists' }, 400);
  const servings = body.servings == null ? 1 : Number(body.servings);
  if (!Number.isFinite(servings) || servings <= 0) return c.json({ error: 'servings must be positive' }, 400);
  const yieldG = positiveOrNull(body.yield_g);
  if (yieldG === 'invalid') return c.json({ error: 'yield_g must be positive or null' }, 400);
  const id = transaction(() => {
    const recipeId = run(
      `INSERT INTO recipes (name, servings, yield_g, instructions, notes, total_calories, total_protein_g,
                            total_carbs_g, total_fat_g, total_fiber_g, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, datetime('now'))`,
      [name, servings, yieldG, body.instructions ? String(body.instructions) : null, body.notes ? String(body.notes) : null],
    );
    insertAliases(recipeId, body.aliases);
    return recipeId;
  });
  return c.json({ id });
});

api.post('/recipes/:id/duplicate', async (c) => {
  const id = Number(c.req.param('id'));
  const source = one<RecipeRow>('SELECT * FROM recipes WHERE id = ?', [id]);
  if (!source) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = String(body.name ?? '').trim() || `${source.name} (copy)`;
  if (nameTaken(name)) return c.json({ error: 'a recipe with that name already exists' }, 400);
  const newId = transaction(() => {
    // shorthand and aliases are lookup keys for the bot; copying them would
    // make "which recipe did you mean" ambiguous, so the copy starts without.
    const copyId = run(
      `INSERT INTO recipes (name, servings, yield_g, instructions, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [name, source.servings, source.yield_g, source.instructions, source.notes],
    );
    run(
      `INSERT INTO recipe_ingredients (recipe_id, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g,
                                       calories, protein_g, carbs_g, fat_g, fiber_g)
       SELECT ?, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g,
              calories, protein_g, carbs_g, fat_g, fiber_g
       FROM recipe_ingredients WHERE recipe_id = ? ORDER BY id`,
      [copyId, id],
    );
    recalculateRecipeTotals(copyId);
    return copyId;
  });
  return c.json({ id: newId });
});

api.patch('/recipes/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = one<RecipeRow>('SELECT * FROM recipes WHERE id = ?', [id]);
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{
    name?: string;
    servings?: number;
    yield_g?: number | null;
    notes?: string | null;
    instructions?: string | null;
    aliases?: string[];
  }>();

  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if ('name' in body) {
    const name = String(body.name ?? '').trim();
    if (!name) return c.json({ error: 'name required' }, 400);
    if (nameTaken(name, id)) return c.json({ error: 'a recipe with that name already exists' }, 400);
    sets.push('name = ?');
    params.push(name);
  }
  if ('servings' in body) {
    const servings = Number(body.servings);
    if (!Number.isFinite(servings) || servings <= 0) return c.json({ error: 'servings must be positive' }, 400);
    sets.push('servings = ?');
    params.push(servings);
  }
  if ('yield_g' in body) {
    const yieldG = positiveOrNull(body.yield_g);
    if (yieldG === 'invalid') return c.json({ error: 'yield_g must be positive or null' }, 400);
    sets.push('yield_g = ?');
    params.push(yieldG);
  }
  if ('notes' in body) {
    sets.push('notes = ?');
    params.push(body.notes == null || String(body.notes).trim() === '' ? null : String(body.notes));
  }
  if ('instructions' in body) {
    sets.push('instructions = ?');
    params.push(body.instructions == null || String(body.instructions).trim() === '' ? null : String(body.instructions));
  }
  if ('aliases' in body && !Array.isArray(body.aliases)) return c.json({ error: 'aliases must be an array' }, 400);

  transaction(() => {
    if (sets.length) run(`UPDATE recipes SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    if ('aliases' in body) replaceAliases(id, body.aliases);
    recalculateRecipeTotals(id);
    // Cascade if it is a component now OR was one before (yield cleared →
    // parents' rows can no longer derive; their stored macros stay, but the
    // parent totals still need to reflect the current basis).
    const wasComponent = existing.yield_g != null && existing.yield_g > 0;
    if (wasComponent || isComponent(id)) cascadeComponentChange(id);
  });
  return c.json(recipeDetail(id));
});

api.post('/recipes/:id/ingredients', async (c) => {
  const id = Number(c.req.param('id'));
  if (!one('SELECT id FROM recipes WHERE id = ?', [id])) return c.json({ error: 'recipe not found' }, 404);
  const body = await c.req.json<{
    product_id?: number | null;
    sub_recipe_id?: number | null;
    quantity_g?: number;
    ingredient_name?: string;
  }>();
  const productId = body.product_id == null ? null : Number(body.product_id);
  const subRecipeId = body.sub_recipe_id == null ? null : Number(body.sub_recipe_id);
  if ((productId == null) === (subRecipeId == null)) {
    return c.json({ error: 'exactly one of product_id or sub_recipe_id is required' }, 400);
  }
  const quantityG = Number(body.quantity_g);
  if (!Number.isFinite(quantityG) || quantityG <= 0) return c.json({ error: 'quantity_g must be positive' }, 400);

  let defaultName: string;
  if (productId != null) {
    const product = one<{ name: string }>('SELECT name FROM products WHERE id = ?', [productId]);
    if (!product) return c.json({ error: 'product not found' }, 404);
    defaultName = product.name;
  } else {
    if (subRecipeId === id) return c.json({ error: 'a recipe cannot contain itself' }, 400);
    const component = one<{ name: string; yield_g: number | null }>('SELECT name, yield_g FROM recipes WHERE id = ?', [
      subRecipeId,
    ]);
    if (!component) return c.json({ error: 'component recipe not found' }, 404);
    if (component.yield_g == null || component.yield_g <= 0) {
      return c.json({ error: 'component recipe needs a positive yield_g before it can be used as an ingredient' }, 400);
    }
    defaultName = component.name;
  }
  const ingredientName = String(body.ingredient_name ?? '').trim() || defaultName;

  const rowId = transaction(() => {
    const newRowId = run(
      `INSERT INTO recipe_ingredients (recipe_id, product_id, sub_recipe_id, ingredient_name, quantity, quantity_g)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, productId, subRecipeId, ingredientName, gramsLabel(quantityG), quantityG],
    );
    refreshRowMacros(newRowId);
    afterRecipeChange(id);
    return newRowId;
  });
  return c.json({ row: ingredientRow(id, rowId), recipe: recipeDetail(id) });
});

api.patch('/recipes/:id/ingredients/:rowId', async (c) => {
  const id = Number(c.req.param('id'));
  const rowId = Number(c.req.param('rowId'));
  if (!one('SELECT id FROM recipe_ingredients WHERE id = ? AND recipe_id = ?', [rowId, id])) {
    return c.json({ error: 'ingredient row not found' }, 404);
  }
  const body = await c.req.json<{ quantity_g?: number }>();
  const quantityG = Number(body.quantity_g);
  if (!Number.isFinite(quantityG) || quantityG <= 0) return c.json({ error: 'quantity_g must be positive' }, 400);
  transaction(() => {
    run('UPDATE recipe_ingredients SET quantity_g = ?, quantity = ? WHERE id = ?', [quantityG, gramsLabel(quantityG), rowId]);
    refreshRowMacros(rowId);
    afterRecipeChange(id);
  });
  return c.json({ row: ingredientRow(id, rowId), recipe: recipeDetail(id) });
});

api.delete('/recipes/:id/ingredients/:rowId', (c) => {
  const id = Number(c.req.param('id'));
  const rowId = Number(c.req.param('rowId'));
  const row = one<{ product_id: number | null; sub_recipe_id: number | null; ingredient_name: string; quantity_g: number | null }>(
    'SELECT product_id, sub_recipe_id, ingredient_name, quantity_g FROM recipe_ingredients WHERE id = ? AND recipe_id = ?',
    [rowId, id],
  );
  if (!row) return c.json({ error: 'ingredient row not found' }, 404);
  transaction(() => {
    run('DELETE FROM recipe_ingredients WHERE id = ?', [rowId]);
    afterRecipeChange(id);
  });
  return c.json({ deleted: row, recipe: recipeDetail(id) });
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
