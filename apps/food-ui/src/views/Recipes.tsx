import { useEffect, useMemo, useState } from 'react';
import type { Nav } from '../App';
import { get, post, money, grams } from '../lib';

interface RecipeRow {
  id: number;
  name: string;
  servings: number | null;
  per_serving_cal: number | null;
  per_serving_prot: number | null;
  per_serving_carb?: number | null;
  per_serving_fat: number | null;
  per_serving_fiber: number | null;
  per_serving_cost: number | null;
  unpriced_ingredients: number | null;
  ingredient_count: number;
  component_count?: number;
  ingredient_names?: string | null;
  ingredient_labels?: string | null;
  aliases?: string | null;
  yield_g: number | null;
  per_100g_cal?: number | null;
  per_100g_prot?: number | null;
  per_100g_fat?: number | null;
  per_100g_fiber?: number | null;
  per_100g_cost?: number | null;
  instructions: string | null;
  notes: string | null;
  archived_at?: string | null;
}

interface IngredientRow {
  id: number;
  ingredient_name: string;
  quantity: string | null;
  quantity_g: number | null;
  calories: number | null;
  protein_g: number | null;
  product_id: number | null;
  sub_recipe_id: number | null;
  product_name: string | null;
  sub_recipe_name: string | null;
  cost: number | null;
}

interface Detail {
  recipe: RecipeRow;
  ingredients: IngredientRow[];
  usedIn: Array<{ recipe_id: number; name: string; quantity_g: number | null }>;
}

export function Recipes({
  nav,
  recipeId,
  onSelect,
}: {
  nav: Nav;
  recipeId: number | null;
  onSelect: (id: number | null) => void;
}) {
  return recipeId === null ? (
    <RecipeTable onOpen={onSelect} />
  ) : (
    <RecipeDetail nav={nav} recipeId={recipeId} onBack={() => onSelect(null)} />
  );
}

// ---------------------------------------------------------------------------
// Table: the recipe list is a searchable, filterable, sortable table. Meals show
// per-serving figures; component recipes (batch yield) show per-100g figures.
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'cal' | 'prot' | 'fat' | 'fiber' | 'cost' | 'ingredients' | 'servings';
type Kind = 'all' | 'meals' | 'components';

interface Filters {
  q: string;
  kind: Kind;
  ingredient: string;
  minProt: string;
  maxCal: string;
  maxCost: string;
  pricedOnly: boolean;
  archived: boolean;
}

const EMPTY_FILTERS: Filters = {
  q: '',
  kind: 'all',
  ingredient: '',
  minProt: '',
  maxCal: '',
  maxCost: '',
  pricedOnly: false,
  archived: false,
};

const FILTER_STORAGE_KEY = 'tango-food.recipes.filters';
const SORT_STORAGE_KEY = 'tango-food.recipes.sort';
type Sort = { key: SortKey; dir: 'asc' | 'desc' };

function loadSort(): Sort {
  try {
    const raw = sessionStorage.getItem(SORT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Sort) : { key: 'name', dir: 'asc' };
  } catch {
    return { key: 'name', dir: 'asc' };
  }
}

function loadFilters(): Filters {
  try {
    const raw = sessionStorage.getItem(FILTER_STORAGE_KEY);
    return raw ? { ...EMPTY_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) } : EMPTY_FILTERS;
  } catch {
    return EMPTY_FILTERS;
  }
}

// Meals compare per serving, components per 100g. Same column, different basis —
// the Type column and row pill say which.
const metric = (r: RecipeRow, key: Exclude<SortKey, 'name' | 'ingredients' | 'servings'>): number | null => {
  const component = Boolean(r.yield_g);
  switch (key) {
    case 'cal':
      return component ? (r.per_100g_cal ?? null) : r.per_serving_cal;
    case 'prot':
      return component ? (r.per_100g_prot ?? null) : r.per_serving_prot;
    case 'fat':
      return component ? (r.per_100g_fat ?? null) : r.per_serving_fat;
    case 'fiber':
      return component ? (r.per_100g_fiber ?? null) : r.per_serving_fiber;
    case 'cost':
      return component ? (r.per_100g_cost ?? null) : r.per_serving_cost;
  }
};

const num = (s: string): number | null => {
  const n = Number(s);
  return s.trim() !== '' && Number.isFinite(n) ? n : null;
};

function RecipeTable({ onOpen }: { onOpen: (id: number) => void }) {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const [sort, setSort] = useState<Sort>(loadSort);
  const [showFilters, setShowFilters] = useState(() => {
    const f = loadFilters();
    return Boolean(f.ingredient || f.minProt || f.maxCal || f.maxCost || f.pricedOnly || f.kind !== 'all');
  });

  // Filters and sort survive the trip into a recipe page and back (session only).
  useEffect(() => {
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);
  useEffect(() => {
    sessionStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  }, [sort]);

  useEffect(() => {
    setLoaded(false);
    get<{ recipes: RecipeRow[] }>(filters.archived ? '/recipes?all=1' : '/recipes')
      .then((r) => {
        setRecipes(r.recipes);
        setLoaded(true);
      })
      .catch((e: Error) => setError(e.message));
  }, [filters.archived]);

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  const rows = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    // "chicken, lime" = every term must appear somewhere in the ingredient list
    const ingredientTerms = filters.ingredient
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const minProt = num(filters.minProt);
    const maxCal = num(filters.maxCal);
    const maxCost = num(filters.maxCost);

    const out = recipes.filter((r) => {
      const component = Boolean(r.yield_g);
      if (filters.kind === 'meals' && component) return false;
      if (filters.kind === 'components' && !component) return false;
      const ingredientText = `${r.ingredient_names ?? ''} | ${r.ingredient_labels ?? ''}`.toLowerCase();
      if (q) {
        const hay = `${r.name} | ${r.aliases ?? ''} | ${ingredientText}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (ingredientTerms.length > 0 && !ingredientTerms.every((t) => ingredientText.includes(t))) return false;
      const prot = metric(r, 'prot');
      const cal = metric(r, 'cal');
      const cost = metric(r, 'cost');
      if (minProt !== null && (prot === null || prot < minProt)) return false;
      if (maxCal !== null && (cal === null || cal > maxCal)) return false;
      if (maxCost !== null && (cost === null || cost > maxCost)) return false;
      if (filters.pricedOnly && ((r.unpriced_ingredients ?? 0) > 0 || cost === null)) return false;
      return true;
    });

    const dir = sort.dir === 'asc' ? 1 : -1;
    const value = (r: RecipeRow): number | string | null => {
      switch (sort.key) {
        case 'name':
          return r.name.toLowerCase();
        case 'ingredients':
          return r.ingredient_count;
        case 'servings':
          return r.servings;
        default:
          return metric(r, sort.key);
      }
    };
    out.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === null || av === undefined) return 1; // unknowns sink regardless of direction
      if (bv === null || bv === undefined) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [recipes, filters, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' },
    );

  const activeFilterCount =
    (filters.kind !== 'all' ? 1 : 0) +
    (filters.ingredient.trim() ? 1 : 0) +
    (num(filters.minProt) !== null ? 1 : 0) +
    (num(filters.maxCal) !== null ? 1 : 0) +
    (num(filters.maxCost) !== null ? 1 : 0) +
    (filters.pricedOnly ? 1 : 0);

  if (error) return <div className="error">{error}</div>;

  const Th = ({ k, label, right, title }: { k: SortKey; label: string; right?: boolean; title?: string }) => (
    <th
      className={`sortable${right ? ' r' : ''}${sort.key === k ? ' on' : ''}`}
      onClick={() => toggleSort(k)}
      title={title}
      aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {sort.key === k && <span className="arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );

  return (
    <>
      <div className="bar">
        <h2>Recipes</h2>
        <span className="note">
          {loaded ? `${rows.length} of ${recipes.length}` : '…'} · meals per serving, components per 100g · click a row
          for the full page
        </span>
      </div>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search name, alias, or ingredient…"
          value={filters.q}
          onChange={(e) => set('q', e.target.value)}
          className="grow"
          autoFocus
        />
        <div className="seg" role="group" aria-label="Recipe type">
          {(
            [
              ['all', 'All'],
              ['meals', 'Meals'],
              ['components', 'Components'],
            ] as Array<[Kind, string]>
          ).map(([k, label]) => (
            <button key={k} className={filters.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setShowFilters((v) => !v)}>
          Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
        </button>
        {(activeFilterCount > 0 || filters.q) && (
          <button className="btn" onClick={() => setFilters({ ...EMPTY_FILTERS, archived: filters.archived })}>
            Clear
          </button>
        )}
        <label className="right note" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={filters.archived} onChange={(e) => set('archived', e.target.checked)} /> show
          archived
        </label>
      </div>
      {showFilters && (
        <div className="panel filters">
          <label>
            <span className="k">Contains ingredients</span>
            <input
              placeholder="chicken, lime  (all must match)"
              value={filters.ingredient}
              onChange={(e) => set('ingredient', e.target.value)}
            />
          </label>
          <label>
            <span className="k">Protein ≥ g</span>
            <input className="short" inputMode="decimal" value={filters.minProt} onChange={(e) => set('minProt', e.target.value)} />
          </label>
          <label>
            <span className="k">Calories ≤</span>
            <input className="short" inputMode="decimal" value={filters.maxCal} onChange={(e) => set('maxCal', e.target.value)} />
          </label>
          <label>
            <span className="k">Cost ≤ $</span>
            <input className="short" inputMode="decimal" value={filters.maxCost} onChange={(e) => set('maxCost', e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={filters.pricedOnly} onChange={(e) => set('pricedOnly', e.target.checked)} />
            <span className="k">fully priced only</span>
          </label>
        </div>
      )}
      <div className="panel scroll">
        <table className="recipes">
          <thead>
            <tr>
              <Th k="name" label="Recipe" />
              <th>Type</th>
              <Th k="servings" label="Srv" right title="Servings per batch" />
              <Th k="cal" label="Cal" right />
              <Th k="prot" label="Protein" right />
              <Th k="fat" label="Fat" right />
              <Th k="fiber" label="Fiber" right />
              <Th k="cost" label="Cost" right />
              <Th k="ingredients" label="Ingr." right title="Ingredient rows" />
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const component = Boolean(r.yield_g);
              return (
                <tr key={r.id} className="row" onClick={() => onOpen(r.id)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(r.id); } }}>
                  <td>
                    <a className="drill" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>{r.name}</a>
                    {r.aliases && <span className="sub">{r.aliases}</span>}
                  </td>
                  <td>
                    {component ? (
                      <span className="pill none">component · {r.yield_g}g</span>
                    ) : (r.component_count ?? 0) > 0 ? (
                      <span className="pill ok">meal · uses component</span>
                    ) : (
                      <span className="pill ok">meal</span>
                    )}
                  </td>
                  <td className="r num">{component ? '—' : (r.servings ?? 1)}</td>
                  <td className="r num">{metric(r, 'cal') ?? '—'}</td>
                  <td className="r num">{grams(metric(r, 'prot'))}</td>
                  <td className="r num">{grams(metric(r, 'fat'))}</td>
                  <td className="r num">{grams(metric(r, 'fiber'))}</td>
                  <td className="r num cost">
                    {/* a cost built from zero priced rows is not a price */}
                    {(r.unpriced_ingredients ?? 0) >= r.ingredient_count ? '—' : money(metric(r, 'cost'))}
                  </td>
                  <td className="r num">{r.ingredient_count}</td>
                  <td>
                    {r.archived_at && <span className="pill none">archived</span>}{' '}
                    {(r.unpriced_ingredients ?? 0) > 0 && (
                      <span className="pill stale" title="Cost is a floor: some rows have no price or grams">
                        {r.unpriced_ingredients} unpriced
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="empty">
                  No recipes match. {activeFilterCount > 0 || filters.q ? 'Try clearing a filter.' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail: a recipe's own page.
// ---------------------------------------------------------------------------

function RecipeDetail({ nav, recipeId, onBack }: { nav: Nav; recipeId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  const load = () => get<Detail>(`/recipes/${recipeId}`).then(setDetail).catch((e: Error) => setError(e.message));

  useEffect(() => {
    setDetail(null);
    setError('');
    void load();
  }, [recipeId]);

  const toggleArchive = async (id: number, archived: boolean) => {
    await post(`/recipes/${id}/archive`, { archived });
    await load();
  };

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <div className="empty">Loading…</div>;

  const r = detail.recipe;
  return (
    <>
      <div className="bar">
        <a className="back" onClick={onBack}>
          ← All recipes
        </a>
      </div>
      <div className="panel rdetail">
        <div>
          <h3>
            {r.name} {r.yield_g && <span className="pill none">component recipe</span>}{' '}
            {r.archived_at && <span className="pill none">archived</span>}
          </h3>
          <div className="meta">
            {r.servings ?? 1} serving{(r.servings ?? 1) !== 1 ? 's' : ''}
            {r.yield_g ? ` · ${r.yield_g}g batch yield` : ''} · {detail.ingredients.length} ingredients
            {r.aliases ? ` · also: ${r.aliases}` : ''}
          </div>
        </div>
        {r.yield_g ? (
          <div className="tiles">
            <div className="tile">
              <div className="k">Batch yield</div>
              <div className="v">{r.yield_g}<small>g</small></div>
            </div>
            <div className="tile">
              <div className="k">Cal / 100g</div>
              <div className="v">{r.per_100g_cal ?? '—'}</div>
            </div>
            <div className="tile">
              <div className="k">Protein / 100g</div>
              <div className="v">{grams(r.per_100g_prot)}</div>
            </div>
            <div className="tile">
              <div className="k">Fat / 100g</div>
              <div className="v">{grams(r.per_100g_fat)}</div>
            </div>
            <div className="tile">
              <div className="k">Fiber / 100g</div>
              <div className="v">{grams(r.per_100g_fiber)}</div>
            </div>
            <div className="tile">
              <div className="k">Cost / 100g</div>
              <div className="v cost">{money(r.per_100g_cost)}</div>
            </div>
          </div>
        ) : (
          <div className="tiles">
            <div className="tile">
              <div className="k">Cal / srv</div>
              <div className="v">{r.per_serving_cal ?? '—'}</div>
            </div>
            <div className="tile">
              <div className="k">Protein</div>
              <div className="v">{grams(r.per_serving_prot)}</div>
            </div>
            <div className="tile">
              <div className="k">Fat</div>
              <div className="v">{grams(r.per_serving_fat)}</div>
            </div>
            <div className="tile">
              <div className="k">Fiber</div>
              <div className="v">{grams(r.per_serving_fiber)}</div>
            </div>
            <div className="tile">
              <div className="k">Cost / srv</div>
              <div className="v cost">{money(r.per_serving_cost)}</div>
            </div>
          </div>
        )}
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Ingredient</th>
                <th className="r">Quantity</th>
                <th className="r">Cal</th>
                <th className="r">Protein</th>
                <th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {detail.ingredients.map((ing) => (
                <tr key={ing.id}>
                  <td>
                    {ing.sub_recipe_id ? (
                      <>
                        <a className="drill" onClick={() => nav.openRecipe(ing.sub_recipe_id!)}>
                          {ing.sub_recipe_name ?? ing.ingredient_name}
                        </a>{' '}
                        <span className="pill none">sub-recipe</span>
                      </>
                    ) : ing.product_id ? (
                      <a className="drill" onClick={() => nav.openProduct(ing.product_id!)}>
                        {ing.ingredient_name}
                      </a>
                    ) : (
                      <>
                        {ing.ingredient_name} <span className="pill none">unmatched</span>
                      </>
                    )}
                  </td>
                  <td className="r num">{ing.quantity_g ? `${ing.quantity_g}g` : (ing.quantity ?? '—')}</td>
                  <td className="r num">{ing.calories ?? '—'}</td>
                  <td className="r num">{grams(ing.protein_g)}</td>
                  <td className="r num cost">{money(ing.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(r.unpriced_ingredients ?? 0) > 0 && (
          <div className="warnrow">
            ⚠ {r.unpriced_ingredients} ingredient{(r.unpriced_ingredients ?? 0) !== 1 ? 's' : ''} without a
            price or gram quantity — recipe cost is a floor, not an exact figure.
          </div>
        )}
        {detail.usedIn.length > 0 && (
          <div className="scroll">
            <div className="ptitle" style={{ paddingLeft: 0 }}>
              Used in {detail.usedIn.length} recipes
            </div>
            <table>
              <tbody>
                {detail.usedIn.map((u) => (
                  <tr key={u.recipe_id}>
                    <td>
                      <a className="drill" onClick={() => nav.openRecipe(u.recipe_id)}>
                        {u.name}
                      </a>
                    </td>
                    <td className="r num">{u.quantity_g ? `${u.quantity_g}g` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="bar">
          <button className="btn" onClick={() => void toggleArchive(r.id, !r.archived_at)}>
            {r.archived_at ? 'Restore from archive' : 'Archive recipe'}
          </button>
          <span className="note">archived recipes keep their history, plans, and links — they just leave the list</span>
        </div>
        {r.instructions && (
          <details>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: '.82rem' }}>
              Notes & instructions
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: '.82rem' }}>{r.instructions}</pre>
          </details>
        )}
      </div>
    </>
  );
}
