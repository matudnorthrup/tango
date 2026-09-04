import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { get, money } from '../lib';
import { usePlans, type PlanDetail } from './Planner';

export function Shopping({
  nav,
  planId,
  onSelectPlan,
}: {
  nav: Nav;
  planId: number | null;
  onSelectPlan: (id: number) => void;
}) {
  const { plans } = usePlans(planId, onSelectPlan);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (planId === null) return;
    get<PlanDetail>(`/plans/${planId}`).then(setDetail).catch((e: Error) => setError(e.message));
  }, [planId]);

  if (error) return <div className="error">{error}</div>;

  const rows = detail?.shopping ?? [];
  const total = rows.reduce((sum, r) => sum + (r.est_cost ?? 0), 0);
  const containers = rows.reduce((sum, r) => sum + (r.containers_to_buy ?? 0), 0);

  return (
    <>
      <div className="bar">
        <h2>Shopping list</h2>
        <select value={planId ?? ''} onChange={(e) => onSelectPlan(Number(e.target.value))}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="note">meals drive the list: per-meal servings × grams, rounded up to containers</span>
      </div>
      <div className="panel scroll">
        {rows.length === 0 ? (
          <div className="empty">
            Nothing to buy yet — add meals to the plan in the Planner, and make sure ingredients have gram
            quantities and listings.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="r">Needed</th>
                <th className="r">Container</th>
                <th className="r">Buy</th>
                <th className="r">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.product_id}>
                  <td>
                    <a className="drill" onClick={() => nav.openProduct(r.product_id)}>
                      {r.product_name}
                    </a>
                  </td>
                  <td className="r num">{Math.round(r.grams_needed)}g</td>
                  <td className="r num">{r.package_grams ? `${r.package_grams}g` : '—'}</td>
                  <td className="r num">{r.containers_to_buy ?? '—'}</td>
                  <td className="r num cost">{money(r.est_cost)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td />
                <td />
                <td className="r num">
                  <b>{containers}</b>
                </td>
                <td className="r num cost">
                  <b>{money(total)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <div className="bar">
        <span className="note">
          Push-to-Foxtrot (Walmart cart queue) lands in Phase 4 — until then this is the store list.
        </span>
      </div>
    </>
  );
}
