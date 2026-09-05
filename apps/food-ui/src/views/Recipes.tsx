import { useEffect, useMemo, useRef, useState } from 'react';
import type { Nav } from '../App';
import { get, post, patch, del, money, grams } from '../lib';

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
  aliases?: string[];
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

type SortKey = 'name' | 'cal' | 'prot' | 'ratio' | 'fat' | 'fiber' | 'cost' | 'ingredients';
const SORT_KEYS: ReadonlySet<string> = new Set(['name', 'cal', 'prot', 'ratio', 'fat', 'fiber', 'cost', 'ingredients']);
type Kind = 'all' | 'meals' | 'components';

interface Filters {
  q: string;
  kind: Kind;
  ingredient: string;
  minProt: string;
  minRatio: string;
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
  minRatio: '',
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
    const parsed = raw ? (JSON.parse(raw) as Sort) : null;
    return parsed && SORT_KEYS.has(parsed.key) ? parsed : { key: 'name', dir: 'asc' };
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

// Every figure is per ONE serving (recipe totals ÷ servings), so a 10-serving
// shepherd's pie compares directly with a 1-serving bowl. Components have no
// servings; they show per 100g. The protein ratio (g protein per 100 kcal) is
// basis-free, so it compares meals and components alike.
const metric = (r: RecipeRow, key: Exclude<SortKey, 'name' | 'ingredients'>): number | null => {
  const component = Boolean(r.yield_g);
  switch (key) {
    case 'ratio': {
      const cal = metric(r, 'cal');
      const prot = metric(r, 'prot');
      return cal && cal > 0 && prot !== null ? Math.round((prot / cal) * 1000) / 10 : null;
    }
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
    return Boolean(f.ingredient || f.minProt || f.minRatio || f.maxCal || f.maxCost || f.pricedOnly || f.kind !== 'all');
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
    const minRatio = num(filters.minRatio);
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
      const ratio = metric(r, 'ratio');
      if (minRatio !== null && (ratio === null || ratio < minRatio)) return false;
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
    (num(filters.minRatio) !== null ? 1 : 0) +
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
          {loaded ? `${rows.length} of ${recipes.length}` : '…'} · every figure is per single serving (components per
          100g) · click a row for the full page
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
        <span className="right">
          <NewRecipeButton onCreated={onOpen} />
          <label className="note" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={filters.archived} onChange={(e) => set('archived', e.target.checked)} /> show
            archived
          </label>
        </span>
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
            <span className="k">Protein / 100 cal ≥</span>
            <input className="short" inputMode="decimal" value={filters.minRatio} onChange={(e) => set('minRatio', e.target.value)} />
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
              <Th k="cal" label="Cal" right />
              <Th k="prot" label="Protein" right />
              <Th k="ratio" label="P / 100 cal" right title="Grams of protein per 100 calories — higher is leaner protein" />
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
                  <td className="r num">{metric(r, 'cal') ?? '—'}</td>
                  <td className="r num">{grams(metric(r, 'prot'))}</td>
                  <td className="r num ratio">{metric(r, 'ratio')?.toFixed(1) ?? '—'}</td>
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
// New recipe: a one-field inline form on the table; the page opens in edit mode.
// ---------------------------------------------------------------------------

const EDIT_NEXT_KEY = 'tango-food.recipes.editNext';

function NewRecipeButton({ onCreated }: { onCreated: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await post<{ id: number }>('/recipes', { name: name.trim(), servings: 1 });
      sessionStorage.setItem(EDIT_NEXT_KEY, String(id));
      setOpen(false);
      setName('');
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn primary" onClick={() => setOpen(true)}>
        New recipe
      </button>
    );
  }
  return (
    <span className="newrecipe">
      <input
        autoFocus
        placeholder="Recipe name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void create()}>
        Create
      </button>
      <button className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail: a recipe's own page, with an edit mode for the header fields and the
// ingredient rows. Grams are the only editable quantity — they are what the
// logger, the cost views, and the macros all run on.
// ---------------------------------------------------------------------------

interface PickResult {
  products: Array<{ id: number; name: string; brand: string | null; grams_per_serving: number | null; calories: number | null; protein_g: number | null }>;
  components: Array<{ id: number; name: string; yield_g: number | null; per_100g_cal: number | null; per_100g_prot: number | null }>;
}

type Pick = { kind: 'product' | 'component'; id: number; name: string };

interface HeaderForm {
  name: string;
  servings: string;
  yield_g: string;
  aliases: string;
  notes: string;
  instructions: string;
}

function formFrom(d: Detail): HeaderForm {
  return {
    name: d.recipe.name,
    servings: String(d.recipe.servings ?? 1),
    yield_g: d.recipe.yield_g ? String(d.recipe.yield_g) : '',
    aliases: (d.aliases ?? []).join(', '),
    notes: d.recipe.notes ?? '',
    instructions: d.recipe.instructions ?? '',
  };
}

function RecipeDetail({ nav, recipeId, onBack }: { nav: Nav; recipeId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<HeaderForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [rowGrams, setRowGrams] = useState<Record<number, string>>({});
  const [undo, setUndo] = useState<{ label: string; payload: Record<string, unknown> } | null>(null);
  // add-ingredient picker
  const [pickQ, setPickQ] = useState('');
  const [pickResults, setPickResults] = useState<PickResult | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [addGrams, setAddGrams] = useState('');
  const [busy, setBusy] = useState(false);
  const pickBox = useRef<HTMLDivElement>(null);

  const apply = (d: Detail) => {
    setDetail(d);
    setRowGrams(Object.fromEntries(d.ingredients.map((i) => [i.id, i.quantity_g === null ? '' : String(i.quantity_g)])));
  };
  const load = () => get<Detail>(`/recipes/${recipeId}`).then(apply).catch((e: Error) => setError(e.message));

  useEffect(() => {
    setDetail(null);
    setError('');
    setUndo(null);
    setPick(null);
    setPickQ('');
    const editNext = sessionStorage.getItem(EDIT_NEXT_KEY);
    const startEditing = editNext === String(recipeId);
    if (startEditing) sessionStorage.removeItem(EDIT_NEXT_KEY);
    setEditing(startEditing);
    get<Detail>(`/recipes/${recipeId}`)
      .then((d) => {
        apply(d);
        if (startEditing) setForm(formFrom(d));
      })
      .catch((e: Error) => setError(e.message));
  }, [recipeId]);

  // picker search, debounced
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => {
      get<PickResult>(`/recipes/pick?q=${encodeURIComponent(pickQ.trim())}`).then(setPickResults).catch(() => setPickResults(null));
    }, 180);
    return () => clearTimeout(t);
  }, [pickQ, editing]);

  const fail = (e: unknown) => setError((e as Error).message);

  const startEdit = () => {
    if (!detail) return;
    setForm(formFrom(detail));
    setEditing(true);
  };

  const headerDirty = () => Boolean(form && detail && JSON.stringify(form) !== JSON.stringify(formFrom(detail)));

  const saveHeader = async (): Promise<boolean> => {
    if (!form || !detail) return true;
    if (!headerDirty()) return true;
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        servings: Number(form.servings) || 1,
        yield_g: form.yield_g.trim() ? Number(form.yield_g) : null,
        notes: form.notes,
        instructions: form.instructions,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
      };
      apply(await patch<Detail>(`/recipes/${recipeId}`, body));
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // One button saves the header fields and leaves edit mode. Ingredient rows
  // have already saved themselves, so Cancel only discards header edits.
  const saveAndClose = async () => {
    if (await saveHeader()) setEditing(false);
  };
  const cancelEdit = async () => {
    if (detail) apply(detail);
    setForm(null);
    setEditing(false);
  };

  const saveRow = async (row: IngredientRow) => {
    const value = Number(rowGrams[row.id]);
    if (!(value > 0) || value === row.quantity_g) return;
    try {
      const r = await patch<{ recipe: Detail }>(`/recipes/${recipeId}/ingredients/${row.id}`, { quantity_g: value });
      apply(r.recipe);
    } catch (e) {
      fail(e);
    }
  };

  const removeRow = async (row: IngredientRow) => {
    try {
      const r = await del<{ deleted: Record<string, unknown>; recipe: Detail }>(`/recipes/${recipeId}/ingredients/${row.id}`);
      apply(r.recipe);
      setUndo({ label: row.ingredient_name, payload: r.deleted });
    } catch (e) {
      fail(e);
    }
  };

  const undoRemove = async () => {
    if (!undo) return;
    try {
      const r = await post<{ recipe: Detail }>(`/recipes/${recipeId}/ingredients`, undo.payload);
      apply(r.recipe);
      setUndo(null);
    } catch (e) {
      fail(e);
    }
  };

  const addRow = async () => {
    const g = Number(addGrams);
    if (!pick || !(g > 0) || busy) return;
    setBusy(true);
    try {
      const body = pick.kind === 'product' ? { product_id: pick.id, quantity_g: g } : { sub_recipe_id: pick.id, quantity_g: g };
      const r = await post<{ recipe: Detail }>(`/recipes/${recipeId}/ingredients`, body);
      apply(r.recipe);
      setPick(null);
      setPickQ('');
      setAddGrams('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async () => {
    try {
      const { id } = await post<{ id: number }>(`/recipes/${recipeId}/duplicate`, {});
      sessionStorage.setItem(EDIT_NEXT_KEY, String(id));
      nav.openRecipe(id);
    } catch (e) {
      fail(e);
    }
  };

  const toggleArchive = async (id: number, archived: boolean) => {
    await post(`/recipes/${id}/archive`, { archived });
    await load();
  };

  if (error && !detail) return <div className="error">{error}</div>;
  if (!detail) return <div className="empty">Loading…</div>;

  const r = detail.recipe;
  const isComponent = Boolean(r.yield_g);
  return (
    <>
      <div className="bar">
        <a className="back" onClick={onBack}>
          ← All recipes
        </a>
        <span className="right">
          {editing ? (
            <>
              <button className="btn" disabled={saving} onClick={() => void cancelEdit()}>
                Cancel
              </button>
              <button className="btn primary" disabled={saving || !form?.name.trim()} onClick={() => void saveAndClose()}>
                {saving ? 'Saving…' : 'Save & done'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void duplicate()}>
                Duplicate
              </button>
              <button className="btn primary" onClick={startEdit}>
                Edit
              </button>
            </>
          )}
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="panel rdetail">
        {editing && form ? (
          <div className="editform">
            <label className="wide">
              <span className="k">Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              <span className="k">Servings</span>
              <input className="short" inputMode="decimal" value={form.servings} onChange={(e) => setForm({ ...form, servings: e.target.value })} />
            </label>
            <label>
              <span className="k">Batch yield g</span>
              <input className="short" inputMode="decimal" placeholder="—" value={form.yield_g} onChange={(e) => setForm({ ...form, yield_g: e.target.value })} />
            </label>
            <label className="wide">
              <span className="k">Aliases (comma separated)</span>
              <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
            </label>
            <label className="full">
              <span className="k">Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <label className="full">
              <span className="k">Instructions</span>
              <textarea rows={4} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
            </label>
            <div className="full note">
              Name and details save with <b>Save &amp; done</b> above. Ingredient rows save as you change them. A batch
              yield turns a recipe into a component that other recipes can use by grams.
            </div>
          </div>
        ) : (
          <div>
            <h3>
              {r.name} {isComponent && <span className="pill none">component recipe</span>}{' '}
              {r.archived_at && <span className="pill none">archived</span>}
            </h3>
            <div className="meta">
              {r.servings ?? 1} serving{(r.servings ?? 1) !== 1 ? 's' : ''}
              {r.yield_g ? ` · ${r.yield_g}g batch yield` : ''} · {detail.ingredients.length} ingredients
              {detail.aliases && detail.aliases.length > 0 ? ` · also: ${detail.aliases.join(', ')}` : ''}
            </div>
          </div>
        )}
        {isComponent ? (
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
        {undo && (
          <div className="undo">
            Removed {undo.label}.{' '}
            <a className="drill" onClick={() => void undoRemove()}>
              Undo
            </a>
            <button className="mini x" onClick={() => setUndo(null)} aria-label="dismiss">×</button>
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
                {editing && <th />}
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
                  <td className="r num">
                    {editing && (ing.product_id || ing.sub_recipe_id) ? (
                      <span className="gramsedit">
                        <input
                          className="short"
                          inputMode="decimal"
                          value={rowGrams[ing.id] ?? ''}
                          onChange={(e) => setRowGrams({ ...rowGrams, [ing.id]: e.target.value })}
                          onBlur={() => void saveRow(ing)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                        />
                        g
                      </span>
                    ) : ing.quantity_g ? (
                      `${ing.quantity_g}g`
                    ) : (
                      ing.quantity ?? '—'
                    )}
                  </td>
                  <td className="r num">{ing.calories ?? '—'}</td>
                  <td className="r num">{grams(ing.protein_g)}</td>
                  <td className="r num cost">{money(ing.cost)}</td>
                  {editing && (
                    <td className="r">
                      <button className="mini x" title="Remove ingredient" onClick={() => void removeRow(ing)}>
                        ×
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing && (
          <div className="addwrap">
            <div className="ptitle" style={{ paddingLeft: 0 }}>Add ingredient</div>

                <div className="addline" ref={pickBox}>
                  <div className="pickwrap">
                    {pick ? (
                      <span className="picked">
                        {pick.name} <span className="pill none">{pick.kind}</span>
                        <button className="mini x" onClick={() => setPick(null)} aria-label="clear">×</button>
                      </span>
                    ) : (
                      <input
                        placeholder="Search products and component recipes…"
                        value={pickQ}
                        onChange={(e) => setPickQ(e.target.value)}
                      />
                    )}
                    {!pick && pickResults && pickQ.trim() !== '' && (
                      <div className="picklist">
                        {pickResults.components.filter((c) => c.id !== recipeId).map((c) => (
                          <button key={`c${c.id}`} onClick={() => setPick({ kind: 'component', id: c.id, name: c.name })}>
                            {c.name} <span className="pill none">component</span>
                            <span className="sub">{c.per_100g_cal ?? '—'} cal · {grams(c.per_100g_prot)} P per 100g</span>
                          </button>
                        ))}
                        {pickResults.products.map((p) => (
                          <button key={`p${p.id}`} onClick={() => setPick({ kind: 'product', id: p.id, name: p.name })}>
                            {p.name}
                            <span className="sub">
                              {p.brand ? `${p.brand} · ` : ''}{p.calories ?? '—'} cal · {grams(p.protein_g)} P per {p.grams_per_serving ?? '?'}g
                            </span>
                          </button>
                        ))}
                        {pickResults.components.length === 0 && pickResults.products.length === 0 && (
                          <div className="sub" style={{ padding: '.5rem .7rem' }}>No matches. Add the product on the Ingredients tab first.</div>
                        )}
                      </div>
                    )}
                  </div>
                  <input
                    className="short"
                    inputMode="decimal"
                    placeholder="grams"
                    value={addGrams}
                    onChange={(e) => setAddGrams(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addRow();
                    }}
                  />
                  <button className="btn primary" disabled={!pick || !(Number(addGrams) > 0) || busy} onClick={() => void addRow()}>
                    Add
                  </button>
                </div>
              
          </div>
        )}
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
        {!editing && (r.instructions || r.notes) && (
          <details>
            <summary className="muted" style={{ cursor: 'pointer', fontSize: '.82rem' }}>
              Notes & instructions
            </summary>
            {r.notes && <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: '.82rem' }}>{r.notes}</pre>}
            {r.instructions && <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: '.82rem' }}>{r.instructions}</pre>}
          </details>
        )}
      </div>
    </>
  );
}
