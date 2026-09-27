import type { Prng } from '../../shared/prng.js';
import { actionKey } from './fingerprint.js';
import type { Control } from './forbidden.js';

/** What the explorer knows of the interface: states seen, actions tried on each. */
export class StateModel {
  private visits = new Map<string, number>();
  private tries = new Map<string, Map<string, number>>();
  /** Steps since an action last led to a state never seen before. */
  sinceNew = 0;
  /** Consecutive steps spent on the same state. */
  sameState = 0;
  private last: string | null = null;

  /** Records the state reached; true when it is new. */
  arrive(state: string): boolean {
    const n = this.visits.get(state) ?? 0;
    this.visits.set(state, n + 1);
    this.sameState = state === this.last ? this.sameState + 1 : 0;
    this.last = state;
    this.sinceNew = n === 0 ? 0 : this.sinceNew + 1;
    return n === 0;
  }

  get states(): number {
    return this.visits.size;
  }

  visitsOf(state: string): number {
    return this.visits.get(state) ?? 0;
  }

  triesOf(state: string, key: string): number {
    return this.tries.get(state)?.get(key) ?? 0;
  }

  tried(state: string, key: string): void {
    const m = this.tries.get(state) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + 1);
    this.tries.set(state, m);
  }
}

/**
 * Novelty weight: untried actions dominate, more so on rarely visited states. On touch devices a
 * collapsed menu (the hamburger, `aria-expanded="false"`) is opened first.
 */
export function weightOf(model: StateModel, state: string, c: Control, touch = false): number {
  const tries = model.triesOf(state, actionKey(c));
  if (tries === 0) return (touch && c.expanded === false ? 50 : 10) / (1 + model.visitsOf(state));
  return 1 / (1 + tries) ** 2;
}

/** Weighted seeded choice. */
export function weightedPick<T>(prng: Prng, items: T[], weight: (t: T) => number): T {
  const w = items.map(weight);
  const total = w.reduce((a, b) => a + b, 0);
  let r = prng.next() * total;
  for (const [i, x] of w.entries()) {
    r -= x;
    if (r < 0) return items[i] as T;
  }
  return items[items.length - 1] as T;
}

export const TEXT_ROLES = new Set(['textbox', 'searchbox']);

export type Decision =
  { kind: 'act'; control: Control } | { kind: 'recover' } | { kind: 'close-modal' };

/**
 * Next move on a screen. Stuck (no new state for `staleSteps`) ⇒ recover; a modal is closed before
 * recovering. Empty fields are filled first, then the buttons of the form just typed into.
 */
export function decide(
  prng: Prng,
  model: StateModel,
  state: string,
  controls: Control[],
  o: {
    modal: boolean;
    staleSteps: number;
    filled: Set<number>;
    touch?: boolean;
    /** Form of the field just filled: its buttons come next, as a person submits what they typed. */
    form?: number;
  },
): Decision {
  if (model.sinceNew >= o.staleSteps || controls.length === 0)
    return o.modal ? { kind: 'close-modal' } : { kind: 'recover' };
  // Inside a modal, only the modal is reachable, as for a person.
  const scope =
    o.modal && controls.some((c) => c.inModal) ? controls.filter((c) => c.inModal) : controls;
  const unfilled = scope.filter((c) => TEXT_ROLES.has(c.role) && !o.filled.has(c.idx));
  const submit = scope.filter(
    (c) => c.role === 'button' && o.form !== undefined && c.formId === o.form,
  );
  const pool =
    unfilled.length && prng.chance(0.7)
      ? unfilled
      : submit.length && prng.chance(0.7)
        ? submit
        : scope;
  return {
    kind: 'act',
    control: weightedPick(prng, pool, (c) => weightOf(model, state, c, o.touch)),
  };
}
