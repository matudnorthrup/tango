import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { get, money } from '../lib';

interface TrendsData {
  movers: Array<{
    product_id: number;
    name: string;
    now_price: number;
    was_price: number;
    delta_pct: number;
    observed_at: string;
  }>;
  scan: { last_scan: string | null; observations: number } | undefined;
  coverage: { priced: number; listings: number; products: number } | undefined;
}

export function Trends({ nav }: { nav: Nav }) {
  const [data, setData] = useState<TrendsData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get<TrendsData>('/trends').then(setData).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const cov = data.coverage;
  return (
    <>
      <div className="bar">
        <h2>Trends</h2>
        <span className="note">spend, cost per meal, and macros over time — charts fill in as scans accumulate</span>
      </div>
      <div className="tiles">
        <div className="tile">
          <div className="k">Products</div>
          <div className="v">{cov?.products ?? '—'}</div>
        </div>
        <div className="tile">
          <div className="k">Listings</div>
          <div className="v">{cov?.listings ?? '—'}</div>
        </div>
        <div className="tile">
          <div className="k">Listings priced</div>
          <div className="v">
            {cov?.priced ?? 0}
            <small> / {cov?.listings ?? 0}</small>
          </div>
        </div>
        <div className="tile">
          <div className="k">Last scan</div>
          <div className="v" style={{ fontSize: '.9rem' }}>
            {data.scan?.last_scan ? data.scan.last_scan.slice(0, 10) : 'never'}
          </div>
          <div className="d">{data.scan?.observations ?? 0} scan observations</div>
        </div>
      </div>
      <div className="panel scroll">
        <div className="ptitle">Price movers</div>
        {data.movers.length === 0 ? (
          <div className="empty">
            No price changes yet — movers appear once a listing has two observations. The weekly Walmart scan
            (or manual prices on ingredient pages) builds the series.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="r">Was</th>
                <th className="r">Now</th>
                <th className="r">Δ</th>
              </tr>
            </thead>
            <tbody>
              {data.movers.map((m) => (
                <tr key={m.product_id}>
                  <td>
                    <a className="drill" onClick={() => nav.openProduct(m.product_id)}>
                      {m.name}
                    </a>
                  </td>
                  <td className="r num">{money(m.was_price)}</td>
                  <td className="r num cost">{money(m.now_price)}</td>
                  <td className="r num">
                    {m.delta_pct > 0 ? '+' : ''}
                    {m.delta_pct}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="bar">
        <span className="note">
          Weekly spend, cost-per-meal-by-slot, and protein/fiber trend charts activate once a few weeks of
          scans and logged meals exist (Phase 3).
        </span>
      </div>
    </>
  );
}
