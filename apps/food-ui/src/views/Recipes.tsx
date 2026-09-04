import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { get, money, grams } from '../lib';

interface RecipeRow {
  id: number;
  name: string;
  servings: number | null;
  per_serving_cal: number | null;
  per_serving_prot: number | null;
  per_serving_fat: number | null;
  per_serving_fiber: number | null;
  per_serving_cost: number | null;
  unpriced_ingredients: number | null;
  ingredient_count: number;
  yield_g: number | null;
  instructions: string | null;
  notes: string | null;
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
  onSelect: (id: number) => void;
}) {
  const [recipes, setRecipes] = useState<RecipeRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get<{ recipes: RecipeRow[] }>('/recipes')
      .then((r) => {
        setRecipes(r.recipes);
        if (recipeId === null && r.recipes[0]) onSelect(r.recipes[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (recipeId === null) return;
    setDetail(null);
    get<Detail>(`/recipes/${recipeId}`).then(setDetail).catch((e: Error) => setError(e.message));
  }, [recipeId]);

  if (error) return <div className="error">{error}</div>;

  const r = detail?.recipe;
  return (
    <>
      <div className="bar">
        <h2>Recipes</h2>
        <span className="note">macros roll up from gram quantities; cost from current prices</span>
      </div>
      <div className="split">
        <div className="panel rlist">
          {recipes.map((rec) => (
            <button key={rec.id} className={rec.id === recipeId ? 'on' : ''} onClick={() => onSelect(rec.id)}>
              {rec.name}
              <span className="sub num">
                {rec.yield_g
                  ? `component · ${rec.yield_g}g batch`
                  : `${rec.per_serving_cal ?? '—'} cal · ${grams(rec.per_serving_prot)} P · ${money(rec.per_serving_cost)}/srv`}
              </span>
            </button>
          ))}
        </div>
        {r && detail ? (
          <div className="panel rdetail">
            <div>
              <h3>
                {r.name} {r.yield_g && <span className="pill none">component recipe</span>}
              </h3>
              <div className="meta">
                {r.servings ?? 1} serving{(r.servings ?? 1) !== 1 ? 's' : ''}
                {r.yield_g ? ` · ${r.yield_g}g batch yield` : ''} · {detail.ingredients.length} ingredients
              </div>
            </div>
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
            {r.instructions && (
              <details>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: '.82rem' }}>
                  Notes & instructions
                </summary>
                <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: '.82rem' }}>{r.instructions}</pre>
              </details>
            )}
          </div>
        ) : (
          <div className="panel empty">Loading…</div>
        )}
      </div>
    </>
  );
}
