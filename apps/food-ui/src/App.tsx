import { useState } from 'react';
import { Ingredients } from './views/Ingredients';
import { Recipes } from './views/Recipes';
import { Planner } from './views/Planner';
import { Shopping } from './views/Shopping';
import { Trends } from './views/Trends';

export type Tab = 'ingredients' | 'recipes' | 'planner' | 'shopping' | 'trends';

// Universal cross-linking: any ingredient or recipe name anywhere navigates to
// that entity's page (spec §6 — "no dead entity names").
export interface Nav {
  openProduct: (id: number) => void;
  openRecipe: (id: number) => void;
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'recipes', label: 'Recipes' },
  { key: 'ingredients', label: 'Ingredients' },
  { key: 'planner', label: 'Planner' },
  { key: 'shopping', label: 'Shopping list' },
  { key: 'trends', label: 'Trends' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('recipes');
  const [productId, setProductId] = useState<number | null>(null);
  const [recipeId, setRecipeId] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);

  const nav: Nav = {
    openProduct: (id) => {
      setProductId(id);
      setTab('ingredients');
    },
    openRecipe: (id) => {
      setRecipeId(id);
      setTab('recipes');
    },
  };

  return (
    <>
      <header className="app">
        <span className="brand">Tango Food</span>
        <span className="env">mac-studio · /tango-food</span>
      </header>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'ingredients' && (
          <Ingredients nav={nav} productId={productId} onClose={() => setProductId(null)} />
        )}
        {tab === 'recipes' && <Recipes nav={nav} recipeId={recipeId} onSelect={setRecipeId} />}
        {tab === 'planner' && <Planner nav={nav} planId={planId} onSelectPlan={setPlanId} />}
        {tab === 'shopping' && <Shopping nav={nav} planId={planId} onSelectPlan={setPlanId} />}
        {tab === 'trends' && <Trends nav={nav} />}
      </main>
      <footer>
        Prices arrive from the weekly Walmart scan or manual entry on an ingredient page. Nutrition
        source of record: FatSecret.
      </footer>
    </>
  );
}
