import { describe, expect, it } from 'vitest';
import { runV2TransitionTable } from '../src/testing/v2-transition-table.js';

describe('V2 transition table', () => {
  it('passes every deterministic V2 scenario', () => {
    const results = runV2TransitionTable();

    expect(results.every((result) => result.ok)).toBe(true);
  });
});
