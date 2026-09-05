// Recipe scaling — two independent dimensions applied to a stored base recipe.
//
//   people  — how many servings (meals) or batches (components) to make
//   phase   — goal multiplier (weight loss 1.0, maintenance, bulk…) that
//             changes what ONE serving is
//
// Each recipe row says what role it plays (scale_lock, on the recipe row):
//   none     scales with both dimensions
//   serving  locked per serving: ignores phase, still multiplies by people
//   batch    locked per batch: ignores both (starter culture, salt)
// and each product says how it comes apart (scale_step_g, on the product):
// computed grams snap to the nearest step, never below one step.
//
// Nothing here writes; the base recipe stays the source of truth.

export type ScaleLock = 'none' | 'serving' | 'batch';

export interface ScalableRow {
  quantity_g: number | null;
  scale_lock?: ScaleLock | null;
  scale_step_g?: number | null;
}

export interface Scale {
  people: number;
  phase: number;
}

export const IDENTITY: Scale = { people: 1, phase: 1 };

export function scaledGrams(row: ScalableRow, scale: Scale): number | null {
  const base = row.quantity_g;
  if (base === null || base === undefined || !(base > 0)) return base ?? null;
  const lock = row.scale_lock ?? 'none';
  let g = base;
  if (lock === 'serving') g = base * scale.people;
  else if (lock === 'none') g = base * scale.people * scale.phase;
  const step = row.scale_step_g;
  if (step && step > 0) g = Math.max(step, Math.round(g / step) * step);
  return Math.round(g * 10) / 10;
}

/** Ratio of scaled to base grams; scale a row's stored macros/cost by this. */
export function scaleFactor(row: ScalableRow, scale: Scale): number {
  const base = row.quantity_g;
  const g = scaledGrams(row, scale);
  if (!base || !(base > 0) || g === null) return 1;
  return g / base;
}

/** True when the computed grams differ from base × people (a step snapped or a lock held). */
export function isAdjusted(row: ScalableRow, scale: Scale): boolean {
  const base = row.quantity_g;
  if (!base) return false;
  const naive = Math.round(base * scale.people * scale.phase * 10) / 10;
  return scaledGrams(row, scale) !== naive;
}

export function isIdentity(scale: Scale): boolean {
  return Math.abs(scale.people - 1) < 1e-9 && Math.abs(scale.phase - 1) < 1e-9;
}

export function formatMultiplier(m: number): string {
  return `×${Number.isInteger(m) ? m : m.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}
