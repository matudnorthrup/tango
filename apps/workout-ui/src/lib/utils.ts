import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtWeight(weight: number | null): string {
  if (weight === null || weight === undefined) return 'BW';
  return Number.isInteger(weight) ? String(weight) : weight.toFixed(1);
}

export function fmtVolume(volume: number): string {
  if (volume >= 10000) return `${(volume / 1000).toFixed(1)}k`;
  return String(Math.round(volume));
}

export function epley(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

/** "2026-06-09" or ISO timestamp -> local Date (avoids UTC shift on date-only strings). */
export function parseDay(value: string): Date {
  const dateOnly = value.slice(0, 10);
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const TYPE_COLORS: Record<string, string> = {
  push: 'bg-rose-500',
  pull: 'bg-sky-500',
  legs: 'bg-lime-500',
  other: 'bg-zinc-400',
};

export const SUPERSET_LABELS = ['–', 'A', 'B', 'C', 'D'];
