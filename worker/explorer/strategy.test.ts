import { describe, expect, it } from 'vitest';
import { createPrng } from '../../shared/prng.js';
import { StateModel, decide, weightOf, weightedPick } from './strategy.js';
import { actionKey } from './fingerprint.js';
import { control } from './test-helpers/controls.js';

const opts = (o: object = {}) => ({ modal: false, staleSteps: 8, filled: new Set<number>(), ...o });

describe('StateModel', () => {
  it('knows new states, counts visits, steps since new and steps on the same state', () => {
    const m = new StateModel();
    expect(m.arrive('a')).toBe(true);
    expect(m.arrive('a')).toBe(false);
    expect(m.sameState).toBe(1);
    expect(m.sinceNew).toBe(1);
    expect(m.arrive('b')).toBe(true);
    expect([m.sinceNew, m.sameState, m.states, m.visitsOf('a'), m.visitsOf('z')]).toEqual([
      0, 0, 2, 2, 0,
    ]);
    m.tried('a', 'k');
    m.tried('a', 'k');
    expect([m.triesOf('a', 'k'), m.triesOf('a', 'j'), m.triesOf('q', 'k')]).toEqual([2, 0, 0]);
  });
});

describe('novelty strategy', () => {
  it('untried actions outweigh tried ones, less so on often visited states', () => {
    const m = new StateModel();
    const c = control({ name: 'X' });
    m.arrive('s');
    const fresh = weightOf(m, 's', c);
    m.tried('s', actionKey(c));
    expect(weightOf(m, 's', c)).toBeLessThan(fresh);
    m.arrive('s');
    expect(weightOf(m, 's', control({ name: 'Y' }))).toBeLessThan(fresh);
  });

  it('prefers the untried action overwhelmingly', () => {
    const m = new StateModel();
    m.arrive('s');
    const a = control({ idx: 0, name: 'A' });
    const b = control({ idx: 1, name: 'B' });
    for (let i = 0; i < 5; i++) m.tried('s', actionKey(a));
    const prng = createPrng(1);
    const picks = Array.from({ length: 200 }, () => decide(prng, m, 's', [a, b], opts()));
    const bs = picks.filter((p) => p.kind === 'act' && p.control.idx === 1).length;
    expect(bs).toBeGreaterThan(190);
  });

  it('recovers when stale or empty; closes a modal first', () => {
    const m = new StateModel();
    m.arrive('s');
    for (let i = 0; i < 8; i++) m.arrive('s');
    const p = createPrng(2);
    expect(decide(p, m, 's', [control()], opts())).toEqual({ kind: 'recover' });
    expect(decide(p, m, 's', [control()], opts({ modal: true }))).toEqual({ kind: 'close-modal' });
    expect(decide(p, new StateModel(), 's', [], opts())).toEqual({ kind: 'recover' });
  });

  it('stays inside an open modal and fills fields first', () => {
    const m = new StateModel();
    m.arrive('s');
    const outside = control({ idx: 0, name: 'Out' });
    const field = control({ idx: 1, role: 'textbox', name: 'Title', inModal: true });
    const ok = control({ idx: 2, name: 'OK', inModal: true });
    const p = createPrng(3);
    const picks = Array.from({ length: 100 }, () =>
      decide(p, m, 's', [outside, field, ok], opts({ modal: true })),
    );
    expect(picks.every((d) => d.kind === 'act' && d.control.inModal)).toBe(true);
    expect(picks.filter((d) => d.kind === 'act' && d.control.idx === 1).length).toBeGreaterThan(60);
    const filled = Array.from({ length: 50 }, () =>
      decide(p, m, 's', [field, ok], opts({ filled: new Set([1]) })),
    );
    expect(filled.some((d) => d.kind === 'act' && d.control.idx === 2)).toBe(true);
    // A "modal" flag with no control inside: the whole page is in scope.
    expect(decide(p, m, 's', [outside], opts({ modal: true }))).toEqual({
      kind: 'act',
      control: outside,
    });
  });

  it('weightedPick falls back to the last item on rounding', () => {
    const one = {
      next: () => 0.9999999999,
      int: () => 0,
      chance: () => false,
      pick: <T>(x: readonly T[]) => x[0] as T,
      fork: () => createPrng(0),
      seed: 0,
    };
    expect(weightedPick(one, ['a', 'b'], () => 0)).toBe('b');
  });
});

describe('replayability', () => {
  /** A deterministic walk: the same seed must give the same sequence of choices. */
  function walk(seed: number): string[] {
    const prng = createPrng(seed).fork('desktop#0');
    const m = new StateModel();
    const controls = Array.from({ length: 6 }, (_, i) => control({ idx: i, name: `C${i}` }));
    const out: string[] = [];
    for (let step = 0; step < 40; step++) {
      const state = `s${step % 5}`;
      m.arrive(state);
      const d = decide(prng, m, state, controls, opts());
      if (d.kind === 'act') {
        m.tried(state, actionKey(d.control));
        out.push(d.control.name);
      } else out.push(d.kind);
    }
    return out;
  }
  it('same seed ⇒ same choices; another seed ⇒ other choices', () => {
    expect(walk(42)).toEqual(walk(42));
    expect(walk(42)).not.toEqual(walk(43));
  });
});
