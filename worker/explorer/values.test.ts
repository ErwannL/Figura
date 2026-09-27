import { describe, expect, it } from 'vitest';
import { createPrng } from '../../shared/prng.js';
import { fieldValue, valueKind } from './values.js';

describe('field values', () => {
  it('are mostly plausible, sometimes edge cases', () => {
    const p = createPrng(7);
    const kinds = Array.from({ length: 400 }, () => valueKind(p));
    expect(kinds.filter((k) => k === 'plausible').length).toBeGreaterThan(280);
    expect(new Set(kinds)).toEqual(new Set(['plausible', 'empty', 'long', 'unicode', 'html']));
    expect(valueKind(createPrng(1), 0)).toBe('plausible');
  });

  it('fit the input type; emails are always synthetic', () => {
    const p = createPrng(9);
    for (const kind of ['plausible', 'html', 'long'] as const)
      expect(fieldValue(p, 'email', kind, 'r1')).toMatch(/^synth\+r1-x\d+@synthetic\.invalid$/);
    expect(Number(fieldValue(p, 'number', 'plausible', 'r1'))).toBeGreaterThan(0);
    expect(['0', '-1', '1000000000']).toContain(fieldValue(p, 'NUMBER', 'long', 'r1'));
    expect(fieldValue(p, 'date', 'plausible', 'r1')).toMatch(/^2030-\d\d-\d\d$/);
    expect(fieldValue(p, 'url', 'plausible', 'r1')).toMatch(/^https:\/\/example\.invalid\//);
    expect(fieldValue(p, 'tel', 'plausible', 'r1')).toMatch(/^\+33 1/);
    expect(fieldValue(p, 'text', 'empty', 'r1')).toBe('');
    expect(fieldValue(p, 'text', 'long', 'r1')).toHaveLength(2000);
    expect(fieldValue(p, 'text', 'unicode', 'r1')).toMatch(/☕.*🚀/u);
    expect(fieldValue(p, 'text', 'html', 'r1')).toMatch(/^<b>fxh\d{4}<\/b>$/);
    expect(fieldValue(p, 'text', 'plausible', 'r1').split(' ').length).toBeLessThanOrEqual(3);
    expect(fieldValue(p, 'textarea', 'plausible', 'r1').length).toBeGreaterThan(0);
  });
});
