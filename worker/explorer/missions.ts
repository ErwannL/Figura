import type { Catalogue, UseCase } from '../../shared/catalogue-schema.js';
import type { Prng } from '../../shared/prng.js';

/**
 * Scripted missions an explorer may chain between free steps: ids of catalogue use cases, so a
 * board is created the one way Figura knows (catalogue/use-cases). Chosen with the session's PRNG.
 * `settings-language` is left out: explorers keep `en` for the forbidden catalogue's second signal.
 */
export const MISSIONS = [
  'create-board',
  'create-list',
  'create-card',
  'edit-card',
  'move-card',
  'global-search',
  'settings-theme',
] as const;
export type MissionId = (typeof MISSIONS)[number];

/** Use cases seeding data before the exploration (`seedData`). */
export const SEED_USE_CASES = ['create-board', 'create-list', 'create-card'] as const;

/** Account setup, run before anything else (never a mission). */
export const ACCOUNT_USE_CASES = ['signup', 'verify-email', 'login'] as const;

/** Probability that a step is a mission rather than a free action. */
export const MISSION_RATE = 1 / 15;

export function useCase(catalogue: Catalogue, id: string): UseCase {
  const uc = catalogue.useCases.find((u) => u.id === id);
  if (!uc) throw new Error(`catalogue has no use case ${id}`);
  return uc;
}

/** Whether the catalogue has a use case (what the replayer asks of Vigie feature ids). */
export function knownIn(catalogue: Catalogue): (id: string) => boolean {
  return (id) => catalogue.useCases.some((u) => u.id === id);
}

/** A mission for this step, or null for a free action. */
export function pickMission(prng: Prng): MissionId | null {
  return prng.chance(MISSION_RATE) ? prng.pick(MISSIONS) : null;
}

/** Catalogue prerequisites of a use case (depth first), without the account ones. */
export function prerequisitesOf(catalogue: Catalogue, id: string): string[] {
  const out: string[] = [];
  const walk = (u: string) => {
    for (const r of useCase(catalogue, u).requires) {
      if ((ACCOUNT_USE_CASES as readonly string[]).includes(r) || out.includes(r)) continue;
      walk(r);
      out.push(r);
    }
  };
  walk(id);
  return out;
}
