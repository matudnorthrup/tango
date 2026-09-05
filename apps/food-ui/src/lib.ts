// Absolute, derived from Vite's base ('/tango-food/'), so the API resolves the
// same whether the page URL carries a trailing slash or not. A relative 'api'
// from '/tango-food' (no slash) resolved to the site root and 404ed.
const base = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const money = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n.toFixed(2)}`;

export const grams = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n * 10) / 10}g`;

export function priceAge(observedAt: string | null | undefined): 'none' | 'fresh' | 'stale' {
  if (!observedAt) return 'none';
  const ageDays = (Date.now() - new Date(observedAt + 'Z').getTime()) / 86400000;
  return ageDays > 14 ? 'stale' : 'fresh';
}

export const MEALS = ['breakfast', 'lunch', 'snack', 'dinner'] as const;
export type Meal = (typeof MEALS)[number];

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayLabel(startDate: string | null, dayIndex: number): string {
  if (!startDate) return `Day ${dayIndex + 1}`;
  const d = new Date(`${startDate}T12:00:00`);
  d.setDate(d.getDate() + dayIndex);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
