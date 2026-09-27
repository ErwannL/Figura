import type { Catalogue, UseCase } from '../shared/catalogue-schema.js';
import type { Persona } from '../shared/persona-schema.js';
import {
  personaFromVigie,
  useCaseOf,
  type VigieScenario,
  type VigieStep,
} from '../shared/vigie.js';
import type { Driver, StepOutcome } from './engine/types.js';
import { initialVars, newCredentials } from './modes.js';

/** What `GET /api/vigie/replays/:runId` reports per step (docs/VIGIE.md). */
export interface ReplayStep {
  index: number;
  action: VigieStep['action'];
  durationMs: number;
  /** Worst HTTP status seen by the step (page load and API calls), null when none was observed. */
  status: number | null;
  ok: boolean;
  /** The step carried an expectation and missed it. */
  breached: boolean;
  error: string | null;
}

export interface ReplayResult {
  reproduced: boolean;
  /** An expectation could not be checked (step not replayable, setup failed): not a verdict. */
  incomplete: string | null;
  /** The target never answered a step: no evidence either way (the run fails TARGET_UNREACHABLE). */
  unreachable: string | null;
  steps: ReplayStep[];
}

export interface ReplayDeps {
  catalogue: Catalogue;
  openDriver: (persona: Persona) => Promise<Driver>;
  requestVerifyUrl: (email: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

const AUTH = new Set(['landing', 'signup', 'verify-email', 'login']);
const PUBLIC_PAGES = /^\/(login|signup|verify-email|forms\/[^/]+)?$/;
/** Ids the replay learns from where the browser went (the browser captures nothing else). */
const ID_IN_PATH: [RegExp, string][] = [
  [/^\/board\/(\d+)/, 'boardId'],
  [/^\/card\/(\d+)/, 'cardId'],
];
/** A path parameter the replay can create when the scenario needs one. */
const MAKES: Record<string, string> = { boardId: 'create-board', cardId: 'create-card' };

export function replayPersona(s: VigieScenario, known: (id: string) => boolean): Persona {
  return personaFromVigie(
    'vigie-replay',
    'replay',
    { traits: s.persona },
    { known, populationWeight: 1 },
  );
}

/** Worst status of a step: a failing API call behind a 200 page is what an incident looks like. */
export function statusOf(o: StepOutcome): number | null {
  const all = [o.navigationStatus, ...o.apiCalls.map((c) => c.status)].filter(
    (x): x is number => typeof x === 'number' && x > 0,
  );
  return all.length ? Math.max(...all) : null;
}

export function breached(step: VigieStep, r: Pick<ReplayStep, 'ok' | 'durationMs' | 'status'>) {
  const e = step.expect;
  if (!e || (e.maxDurationMs === undefined && e.status === undefined)) return false;
  if (!r.ok) return true;
  if (e.maxDurationMs !== undefined && r.durationMs > e.maxDurationMs) return true;
  return e.status !== undefined && r.status !== e.status;
}

/** A step got no HTTP response at all: the target is down or still starting. */
class Unreachable extends Error {}

/** Account setup and use cases for one persona, step by step (also the explorer's). */
export class Replayer {
  private vars: Record<string, string>;
  private done = new Set<string>();
  private n = 0;

  constructor(
    private readonly runId: string,
    private readonly persona: Persona,
    private readonly driver: Driver,
    private readonly deps: Omit<ReplayDeps, 'openDriver'>,
    private readonly creds: { email: string; password: string },
    private readonly known: (id: string) => boolean,
  ) {
    this.vars = initialVars(runId)(persona);
  }

  private uc(id: string): UseCase {
    return this.deps.catalogue.useCases.find((u) => u.id === id) as UseCase;
  }

  async attempt(useCase: UseCase): Promise<StepOutcome> {
    this.n += 1;
    const out = await this.driver.attempt(useCase, {
      persona: this.persona,
      vars: {
        ...this.vars,
        email: this.creds.email,
        password: this.creds.password,
        locale: this.persona.locale,
        personaName: this.persona.displayName,
      },
      mistakes: [],
      label: `${this.persona.id}-replay-${this.n}-${useCase.id}`,
    });
    Object.assign(this.vars, out.captured);
    for (const page of out.pages)
      for (const [re, name] of ID_IN_PATH) {
        const m = re.exec(page);
        if (m) this.vars[name] = m[1] as string;
      }
    if (out.unreachable) throw new Unreachable(`${useCase.id}: ${out.error}`);
    if (out.ok) this.done.add(useCase.id);
    return out;
  }

  /** Runs a use case untimed (setup), failing the replay step if it fails. */
  async setup(id: string): Promise<void> {
    if (this.done.has(id)) return;
    if (id === 'verify-email') {
      const url = await this.deps.requestVerifyUrl(this.creds.email);
      this.vars.verifyUrl = url;
      this.vars.verifyToken = new URL(url).searchParams.get('token') ?? '';
    }
    const out = await this.attempt(this.uc(id));
    if (!out.ok) throw new Error(`setup ${id} failed: ${out.error}`);
  }

  async signedIn(): Promise<void> {
    for (const id of ['signup', 'verify-email', 'login']) await this.setup(id);
  }

  /** Prerequisites of a use case (catalogue `requires`), depth first, untimed. */
  async prerequisites(id: string): Promise<void> {
    for (const r of this.uc(id).requires) {
      if (AUTH.has(r)) continue;
      await this.prerequisites(r);
      await this.setup(r);
    }
  }

  /** Fills `:param` segments; creates a board or card when the scenario needs one. */
  async resolve(template: string): Promise<string> {
    let path = template;
    for (const [, name] of template.matchAll(/:(\w+)/g)) {
      const maker = MAKES[name as string];
      if (!this.vars[name as string] && maker) {
        await this.prerequisites(maker);
        await this.setup(maker);
      }
      const value = this.vars[name as string];
      if (!value) throw new Error(`no value for :${name} in ${template}`);
      path = path.replace(`:${name}`, value);
    }
    return path;
  }

  /** The timed part of one Vigie step. */
  async step(s: VigieStep): Promise<StepOutcome | number> {
    const target = s.target === null || s.target === undefined ? null : String(s.target);
    if (s.action === 'wait') {
      const ms = Math.min(Math.max(Number(target) || 1000, 0), 10_000);
      await this.deps.sleep(ms);
      return ms;
    }
    if (s.action === 'click')
      throw new Error('click steps (data-vigie ids) are not replayed: Figura uses roles and names');
    if (s.action === 'signup') return this.attempt(this.uc('signup'));
    if (s.action === 'login') {
      await this.setup('signup');
      await this.setup('verify-email');
      return this.attempt(this.uc('login'));
    }
    if (s.action === 'use_feature') {
      const id = useCaseOf(target ?? '', this.known);
      if (!id) throw new Error(`unknown feature ${target}`);
      await this.signedIn();
      await this.prerequisites(id);
      return this.attempt(this.uc(id));
    }
    const template = target ?? '/';
    if (!PUBLIC_PAGES.test(template)) await this.signedIn();
    const path = await this.resolve(template);
    return this.attempt({
      ...this.uc('landing'),
      id: 'vigie-visit',
      ui: [{ action: 'goto', path }],
    });
  }
}

/** Replays a Vigie scenario with one persona; never throws for a failing step. */
export async function replayScenario(
  runId: string,
  scenario: VigieScenario,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const known = (id: string) => deps.catalogue.useCases.some((u) => u.id === id);
  const persona = replayPersona(scenario, known);
  const driver = await deps.openDriver(persona);
  const r = new Replayer(runId, persona, driver, deps, newCredentials(runId)(persona), known);
  const steps: ReplayStep[] = [];
  let incomplete: string | null = null;
  let unreachable: string | null = null;
  try {
    for (const [index, s] of scenario.steps.entries()) {
      let row: Omit<ReplayStep, 'breached'>;
      let replayed = true;
      try {
        const out = await r.step(s);
        row =
          typeof out === 'number'
            ? { index, action: s.action, durationMs: out, status: null, ok: true, error: null }
            : {
                index,
                action: s.action,
                durationMs: out.wallMs,
                status: statusOf(out),
                ok: out.ok,
                error: out.error,
              };
      } catch (e) {
        // Not the target misbehaving: Figura could not replay the step (or set it up).
        replayed = false;
        const error = (e as Error).message;
        row = { index, action: s.action, durationMs: 0, status: null, ok: false, error };
        if (e instanceof Unreachable) unreachable = `step ${index}: ${error}`;
        else if (s.expect && incomplete === null) incomplete = `step ${index}: ${error}`;
      }
      steps.push({ ...row, breached: replayed && breached(s, row) });
      // Nothing after a step the target did not answer would be evidence either.
      if (unreachable) break;
    }
  } finally {
    await driver.close();
  }
  return {
    reproduced: unreachable === null && steps.some((s) => s.breached),
    incomplete,
    unreachable,
    steps,
  };
}
