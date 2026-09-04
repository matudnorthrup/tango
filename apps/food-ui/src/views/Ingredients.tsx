import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { get, post, money, grams, priceAge } from '../lib';

interface ProductRow {
  id: number;
  name: string;
  brand: string | null;
  serving_size: string | null;
  grams_per_serving: number | null;
  calories: number | null;
  protein_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  retailer: string | null;
  price: number | null;
  observed_at: string | null;
  price_per_serving: number | null;
  listing_count: number;
  discontinued_date: string | null;
  category: string | null;
}

interface Listing {
  id: number;
  retailer: string;
  retailer_item_id: string | null;
  package_description: string | null;
  package_grams: number | null;
  servings_per_container: number | null;
  preferred: number;
  price: number | null;
  observed_at: string | null;
  price_per_serving: number | null;
}

interface Detail {
  product: ProductRow & { carbs_g: number | null; fatsecret_food_id: string | null; fatsecret_serving_id: string | null; notes: string | null; source: string | null };
  listings: Listing[];
  history: Array<{ listing_id: number; observed_at: string; price: number; source: string }>;
  usedIn: Array<{ recipe_id: number; name: string; quantity: string | null; quantity_g: number | null }>;
}

function PricePill({
  observedAt,
  hasListing,
  category,
}: {
  observedAt: string | null;
  hasListing: boolean;
  category?: string | null;
}) {
  if (category === 'restaurant') return <span className="pill none">restaurant · nutrition only</span>;
  if (!hasListing) return <span className="pill none">no listing</span>;
  const age = priceAge(observedAt);
  if (age === 'none') return <span className="pill stale">no price yet</span>;
  if (age === 'stale') return <span className="pill stale">stale price</span>;
  return <span className="pill ok">priced</span>;
}

function ProductDetail({ id, nav, onClose }: { id: number; nav: Nav; onClose: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [priceInputs, setPriceInputs] = useState<Record<number, string>>({});

  const load = () => {
    get<Detail>(`/products/${id}`).then(setDetail).catch((e: Error) => setError(e.message));
  };
  useEffect(load, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <div className="empty">Loading…</div>;
  const p = detail.product;

  const addPrice = async (listingId: number) => {
    const value = Number(priceInputs[listingId]);
    if (!Number.isFinite(value) || value <= 0) return;
    await post(`/listings/${listingId}/price`, { price: value });
    setPriceInputs((prev) => ({ ...prev, [listingId]: '' }));
    load();
  };

  return (
    <>
      <div className="bar">
        <a className="back" onClick={onClose}>
          ← Ingredients
        </a>
        <span className="right">
          <button
            className="btn"
            onClick={() => void post(`/products/${id}/archive`, { archived: !p.discontinued_date }).then(load)}
          >
            {p.discontinued_date ? 'Restore from archive' : 'Archive ingredient'}
          </button>
        </span>
      </div>
      <div className="bar">
        <h2>{p.name}</h2>
        <span className="note">
          {[p.brand, p.source].filter(Boolean).join(' · ')}
          {p.fatsecret_food_id && (
            <>
              {' · FatSecret '}
              <span className="num">
                #{p.fatsecret_food_id}/{p.fatsecret_serving_id}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="tiles">
        <div className="tile">
          <div className="k">Serving</div>
          <div className="v" style={{ fontSize: '.95rem' }}>
            {p.serving_size ?? '—'}
          </div>
          <div className="d">{p.grams_per_serving ? `${p.grams_per_serving}g` : 'grams unknown'}</div>
        </div>
        <div className="tile">
          <div className="k">Calories</div>
          <div className="v">{p.calories ?? '—'}</div>
        </div>
        <div className="tile">
          <div className="k">Protein</div>
          <div className="v">{grams(p.protein_g)}</div>
        </div>
        <div className="tile">
          <div className="k">Carbs</div>
          <div className="v">{grams(p.carbs_g)}</div>
        </div>
        <div className="tile">
          <div className="k">Fat</div>
          <div className="v">{grams(p.fat_g)}</div>
        </div>
        <div className="tile">
          <div className="k">Fiber</div>
          <div className="v">{grams(p.fiber_g)}</div>
        </div>
        <div className="tile">
          <div className="k">$ / serving</div>
          <div className="v cost">{money(detail.listings.find((l) => l.preferred)?.price_per_serving ?? detail.listings[0]?.price_per_serving)}</div>
        </div>
      </div>

      <div className="panel scroll">
        <div className="ptitle">Listings</div>
        {detail.listings.length === 0 ? (
          <div className="empty">No retail listings yet — added during the Walmart item-ID backfill.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Retailer</th>
                <th>Package</th>
                <th className="r">Net</th>
                <th className="r">Servings</th>
                <th className="r">Price</th>
                <th>Status</th>
                <th>Set price</th>
              </tr>
            </thead>
            <tbody>
              {detail.listings.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.retailer}
                    {l.retailer_item_id && <span className="sub num">item {l.retailer_item_id}</span>}
                  </td>
                  <td>{l.package_description ?? '—'}</td>
                  <td className="r num">{l.package_grams ? `${l.package_grams}g` : '—'}</td>
                  <td className="r num">{l.servings_per_container ?? '—'}</td>
                  <td className="r num cost">{money(l.price)}</td>
                  <td>
                    {l.preferred ? <span className="pill ok">preferred</span> : <span className="pill none">alternate</span>}{' '}
                    <PricePill observedAt={l.observed_at} hasListing />
                  </td>
                  <td>
                    <input
                      className="short"
                      inputMode="decimal"
                      placeholder="$"
                      value={priceInputs[l.id] ?? ''}
                      onChange={(e) => setPriceInputs((prev) => ({ ...prev, [l.id]: e.target.value }))}
                    />{' '}
                    <button className="btn" onClick={() => void addPrice(l.id)}>
                      Save
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel scroll">
        <div className="ptitle">Price history</div>
        {detail.history.length === 0 ? (
          <div className="empty">No observations yet — the weekly scan or a manual price starts the series.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Observed</th>
                <th className="r">Price</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {detail.history.slice(0, 20).map((h, i) => (
                <tr key={i}>
                  <td className="num">{h.observed_at.slice(0, 16).replace('T', ' ')}</td>
                  <td className="r num cost">{money(h.price)}</td>
                  <td>
                    <span className="pill none">{h.source}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel scroll">
        <div className="ptitle">Used in {detail.usedIn.length} recipes</div>
        {detail.usedIn.length === 0 ? (
          <div className="empty">Not used in any recipe yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Recipe</th>
                <th className="r">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {detail.usedIn.map((u) => (
                <tr key={u.recipe_id}>
                  <td>
                    <a className="drill" onClick={() => nav.openRecipe(u.recipe_id)}>
                      {u.name}
                    </a>
                  </td>
                  <td className="r num">{u.quantity_g ? `${u.quantity_g}g` : (u.quantity ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function Ingredients({
  nav,
  productId,
  onClose,
}: {
  nav: Nav;
  productId: number | null;
  onClose: () => void;
}) {
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    get<{ products: ProductRow[] }>(showArchived ? '/products?all=1' : '/products')
      .then((r) => setProducts(r.products))
      .catch((e: Error) => setError(e.message));
  }, [productId, showArchived]);

  if (productId !== null) return <ProductDetail id={productId} nav={nav} onClose={onClose} />;
  if (error) return <div className="error">{error}</div>;

  const term = filter.trim().toLowerCase();
  const visible = products.filter(
    (p) => !term || p.name.toLowerCase().includes(term) || (p.brand ?? '').toLowerCase().includes(term),
  );

  return (
    <>
      <div className="bar">
        <h2>Ingredients</h2>
        <span className="note">{products.length} products · nutrition verified against FatSecret</span>
        <span className="right">
          <label className="note" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
          </label>
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </span>
      </div>
      <div className="panel scroll">
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>Serving</th>
              <th className="r">Cal</th>
              <th className="r">Protein</th>
              <th className="r">Fat</th>
              <th className="r">Fiber</th>
              <th className="r">$ / serving</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id}>
                <td>
                  <a className="drill" onClick={() => nav.openProduct(p.id)}>
                    {p.name}
                  </a>
                  <span className="sub">{[p.brand, p.retailer].filter(Boolean).join(' · ') || '—'}{p.discontinued_date && ' · archived'}</span>
                </td>
                <td>
                  {p.serving_size ?? '—'}
                  {p.grams_per_serving && <span className="num"> · {p.grams_per_serving}g</span>}
                </td>
                <td className="r num">{p.calories ?? '—'}</td>
                <td className="r num">{grams(p.protein_g)}</td>
                <td className="r num">{grams(p.fat_g)}</td>
                <td className="r num">{grams(p.fiber_g)}</td>
                <td className="r num cost">{money(p.price_per_serving)}</td>
                <td>
                  <PricePill observedAt={p.observed_at} hasListing={p.listing_count > 0} category={p.category} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
