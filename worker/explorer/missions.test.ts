import { describe, expect, it } from 'vitest';
import { loadSimData } from '../data.js';
import { repoRoot } from '../../shared/paths.js';
import { createPrng } from '../../shared/prng.js';
import { forbiddenRule } from './forbidden.js';
import {
  MISSIONS,
  SEED_USE_CASES,
  knownIn,
  pickMission,
  prerequisitesOf,
  useCase,
} from './missions.js';
import { control } from './test-helpers/controls.js';

const { catalogue } = loadSimData(repoRoot());

describe('mission catalogue', () => {
  it('names catalogue use cases only, none of them touching a forbidden control', () => {
    for (const id of [...MISSIONS, ...SEED_USE_CASES]) {
      const uc = useCase(catalogue, id);
      for (const step of uc.ui) {
        if (!('target' in step)) continue;
        const c = control({ role: step.target.role, name: step.target.name.en });
        expect(forbiddenRule(c, 'http://x'), `${id}: ${step.target.name.en}`).toBeNull();
      }
    }
    expect(() => useCase(catalogue, 'nope')).toThrow('no use case nope');
    expect([knownIn(catalogue)('create-board'), knownIn(catalogue)('nope')]).toEqual([true, false]);
  });

  it('picks rarely and deterministically', () => {
    const run = (seed: number) => {
      const p = createPrng(seed);
      return Array.from({ length: 300 }, () => pickMission(p));
    };
    expect(run(5)).toEqual(run(5));
    const hits = run(5).filter(Boolean).length;
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(45);
  });

  it('lists prerequisites depth first, without the account use cases', () => {
    expect(prerequisitesOf(catalogue, 'create-board')).toEqual([]);
    const card = prerequisitesOf(catalogue, 'move-card');
    expect(card.indexOf('create-board')).toBeLessThan(card.indexOf('create-card'));
    expect(card).not.toContain('login');
    const diamond = {
      useCases: [
        { id: 'a', requires: ['b', 'c'] },
        { id: 'b', requires: ['c'] },
        { id: 'c', requires: [] },
      ],
    } as never;
    expect(prerequisitesOf(diamond, 'a')).toEqual(['c', 'b']);
  });
});
