import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { get, post, patch, del, money, grams, MEALS, dayLabel, type Meal } from '../lib';

export interface PlanRow {
  id: number;
  name: string;
  start_date: string | null;
  entry_count: number;
  cost_total: number | null;
}

interface Entry {
  id: number;
  day_index: number;
  meal: Meal;
  servings: number;
  recipe_id: number | null;
  product_id: number | null;
  name: string;
  per_serving_cal: number | null;
  per_serving_cost: number | null;
}

interface DaySummary {
  day_index: number;
  servings: number;
  calories: number | null;
  protein_g: number | null;
  fiber_g: number | null;
  cost_total: number | null;
}

export interface PlanDetail {
  plan: { id: number; name: string; start_date: string | null };
  entries: Entry[];
  days: DaySummary[];
  shopping: Array<{
    product_id: number;
    product_name: string;
    grams_needed: number;
    package_grams: number | null;
    containers_to_buy: number | null;
    est_cost: number | null;
  }>;
}

export function usePlans(planId: number | null, onSelectPlan: (id: number) => void) {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  useEffect(() => {
    get<{ plans: PlanRow[] }>('/plans').then((r) => {
      setPlans(r.plans);
      if (planId === null && r.plans[0]) onSelectPlan(r.plans[0].id);
    });
  }, []);
  return { plans, setPlans };
}

const formatServings = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export function Planner({
  nav,
  planId,
  onSelectPlan,
}: {
  nav: Nav;
  planId: number | null;
  onSelectPlan: (id: number) => void;
}) {
  const { plans, setPlans } = usePlans(planId, onSelectPlan);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState('');
  const [newPlanName, setNewPlanName] = useState('');
  const [newPlanDate, setNewPlanDate] = useState('');
  const [recipes, setRecipes] = useState<Array<{ id: number; name: string; yield_g: number | null }>>([]);
  const [add, setAdd] = useState<{ day: number; meal: Meal; recipeId: string; servings: string }>({
    day: 0,
    meal: 'dinner',
    recipeId: '',
    servings: '2',
  });

  const load = () => {
    if (planId === null) return;
    get<PlanDetail>(`/plans/${planId}`).then(setDetail).catch((e: Error) => setError(e.message));
  };
  useEffect(load, [planId]);
  useEffect(() => {
    get<{ recipes: Array<{ id: number; name: string; yield_g: number | null }> }>('/recipes').then((r) =>
      setRecipes(r.recipes.filter((rec) => !rec.yield_g)),
    );
  }, []);

  const createPlan = async () => {
    if (!newPlanName.trim()) return;
    const { id } = await post<{ id: number }>('/plans', {
      name: newPlanName.trim(),
      start_date: newPlanDate || undefined,
    });
    setNewPlanName('');
    setNewPlanDate('');
    const r = await get<{ plans: PlanRow[] }>('/plans');
    setPlans(r.plans);
    onSelectPlan(id);
  };

  const addEntry = async () => {
    if (!planId || !add.recipeId) return;
    await post(`/plans/${planId}/entries`, {
      day_index: add.day,
      meal: add.meal,
      recipe_id: Number(add.recipeId),
      servings: Number(add.servings) || 1,
    });
    load();
  };

  // Servings are fractional: half a yogurt cup or a quarter shake are real
  // portions. Arrows step by ½; clicking the count lets you type any amount.
  const setServings = async (entry: Entry, value: number) => {
    const next = Math.round(Math.max(0, Math.min(24, value)) * 100) / 100;
    if (next === entry.servings) return;
    await patch(`/entries/${entry.id}`, { servings: next });
    load();
  };
  const bump = (entry: Entry, delta: number) => setServings(entry, entry.servings + delta);
  const [editingEntry, setEditingEntry] = useState<{ id: number; value: string } | null>(null);
  const commitEdit = async (entry: Entry) => {
    if (!editingEntry || editingEntry.id !== entry.id) return;
    const value = Number(editingEntry.value);
    setEditingEntry(null);
    if (Number.isFinite(value)) await setServings(entry, value);
  };

  const remove = async (entry: Entry) => {
    await del(`/entries/${entry.id}`);
    load();
  };

  if (error) return <div className="error">{error}</div>;

  const startDate = detail?.plan.start_date ?? null;
  const dayIndexes = Array.from({ length: 7 }, (_, i) => i);
  const weekTotal = detail?.days.reduce((sum, d) => sum + (d.cost_total ?? 0), 0) ?? 0;

  return (
    <>
      <div className="bar">
        <h2>Planner</h2>
        <select value={planId ?? ''} onChange={(e) => onSelectPlan(Number(e.target.value))}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="right">
          <input placeholder="New plan name" value={newPlanName} onChange={(e) => setNewPlanName(e.target.value)} />
          <input type="date" value={newPlanDate} onChange={(e) => setNewPlanDate(e.target.value)} />
          <button className="btn" onClick={() => void createPlan()}>
            Create
          </button>
        </span>
      </div>

      {plans.length === 0 && <div className="panel empty">No plans yet — create the first week above.</div>}

      {detail && (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="k">Week total</div>
              <div className="v cost">{money(weekTotal)}</div>
              <div className="d">unpriced items excluded</div>
            </div>
            <div className="tile">
              <div className="k">Servings planned</div>
              <div className="v">{detail.days.reduce((s, d) => s + (d.servings ?? 0), 0)}</div>
            </div>
            <div className="tile">
              <div className="k">Days planned</div>
              <div className="v">{detail.days.length}</div>
            </div>
          </div>

          <div className="panel">
            {dayIndexes.map((day) => {
              const entries = detail.entries.filter((e) => e.day_index === day);
              const summary = detail.days.find((d) => d.day_index === day);
              return (
                <div className="day" key={day}>
                  <div className="dayhead">
                    <b>{dayLabel(startDate, day)}</b>
                    {summary && (
                      <span className="num">
                        {summary.servings} servings · {summary.calories ?? 0} cal · {grams(summary.protein_g)} P ·{' '}
                        {grams(summary.fiber_g)} fiber · <span className="cost">{money(summary.cost_total)}</span>
                      </span>
                    )}
                  </div>
                  {entries.length > 0 && (
                    <div className="slots">
                      {entries.map((e) => (
                        <div className="slot" key={e.id}>
                          <span className="k">
                            {e.meal}
                            <button className="mini x" title="Remove" onClick={() => void remove(e)}>
                              ✕
                            </button>
                          </span>
                          {e.recipe_id ? (
                            <a className="drill" onClick={() => nav.openRecipe(e.recipe_id!)}>
                              {e.name}
                            </a>
                          ) : e.product_id ? (
                            <a className="drill" onClick={() => nav.openProduct(e.product_id!)}>
                              {e.name}
                            </a>
                          ) : (
                            e.name
                          )}
                          <span className="m">
                            <button className="mini" onClick={() => void bump(e, -0.5)} aria-label="half serving less">
                              −
                            </button>{' '}
                            ×
                            {editingEntry?.id === e.id ? (
                              <input
                                className="short ctedit"
                                inputMode="decimal"
                                autoFocus
                                value={editingEntry.value}
                                onChange={(ev) => setEditingEntry({ id: e.id, value: ev.target.value })}
                                onBlur={() => void commitEdit(e)}
                                onKeyDown={(ev) => {
                                  if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                                  if (ev.key === 'Escape') setEditingEntry(null);
                                }}
                              />
                            ) : (
                              <span
                                className="ct clickable"
                                title="Click to type a serving count (¼, ½, 1.5…)"
                                onClick={() => setEditingEntry({ id: e.id, value: String(e.servings) })}
                              >
                                {formatServings(e.servings)}
                              </span>
                            )}{' '}
                            <button className="mini" onClick={() => void bump(e, 0.5)} aria-label="half serving more">
                              +
                            </button>{' '}
                            · {e.per_serving_cal ?? '—'} cal/srv · {money((e.per_serving_cost ?? 0) * e.servings || null)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="addrow">
              <select value={add.day} onChange={(e) => setAdd({ ...add, day: Number(e.target.value) })}>
                {dayIndexes.map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(startDate, d)}
                  </option>
                ))}
              </select>
              <select value={add.meal} onChange={(e) => setAdd({ ...add, meal: e.target.value as Meal })}>
                {MEALS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select value={add.recipeId} onChange={(e) => setAdd({ ...add, recipeId: e.target.value })}>
                <option value="">Pick a recipe…</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <input
                className="short"
                inputMode="decimal"
                title="Servings — fractions are fine (0.5, 0.25)"
                value={add.servings}
                onChange={(e) => setAdd({ ...add, servings: e.target.value })}
                aria-label="servings"
              />
              <button className="btn primary" disabled={!add.recipeId} onClick={() => void addEntry()}>
                Add meal
              </button>
            </div>
          </div>
          <div className="bar">
            <span className="note">
              Servings are per meal — a school-day lunch is ×1 while dinner is ×2. Changes ripple into cost and
              the shopping list.
            </span>
          </div>
        </>
      )}
    </>
  );
}
