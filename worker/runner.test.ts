import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../app/test-helpers/db.js';
import type { Db } from '../app/db/pool.js';
import { createRun, getRun, requestCancel, transition, transitionsOf } from '../app/db/runs.js';
import { getReport } from '../app/db/misc.js';
import { eventsOf } from '../app/db/events.js';
import { saveVigieSet } from '../app/db/vigie.js';
import type { VigieScenario } from '../shared/vigie.js';
import { dataKey } from '../shared/crypto.js';
import { repoRoot } from '../shared/paths.js';
import { runConfigSchema, type RunConfigInput } from '../shared/run-config.js';
import { SECRET } from '../fake-orqea/test-helpers/fake.js';
import { liveFake } from './test-helpers/live-fake.js';
import { loadSimData } from './data.js';
import { recoverStale, tick, workLoop } from './loop.js';
import { executeRun, purgeScreenshots, type WorkerConfig, type WorkerDeps } from './runner.js';
import { flattenEndpoints } from './target/client.js';
import type { FunnelReport } from './reports/funnel.js';
import type { LoadReport } from './reports/load.js';

const data = loadSimData(repoRoot());
let db: Db;
let browser: Browser;
let fake: Awaited<ReturnType<typeof liveFake>>;
const shots = mkdtempSync(join(tmpdir(), 'figura-shots-'));
const cfg: WorkerConfig = {
  workerId: 'w-test',
  serviceSecret: SECRET,
  dataKey: dataKey('k'.repeat(32)),
  screenshotsDir: shots,
  localHosts: [],
  productionHosts: [],
  caps: { accounts: 50, requestsPerSecond: 200, rows: 100000 },
  stepTimeoutMs: 2500,
  cancelPollMs: 20,
  rowsPerAccount: 50,
  targets: {},
  readyTimeoutMs: 5000,
  readyPollMs: 50,
  explorerRetentionDays: 14,
};
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
  await db.end();
});
beforeEach(async () => {
  await db?.end();
  db = await testDb();
  fake = await liveFake();
});
afterEach(async () => fake.close());

const deps = (o: Partial<WorkerDeps> = {}): WorkerDeps => ({
  db,
  data,
  fetchImpl: fetch,
  launch: async () => browser,
  nowS: () => Math.floor(Date.now() / 1000),
  ...o,
});
// The shared browser must survive each run's drivers.close().
const keepOpen = {
  ...deps(),
  launch: async () =>
    ({
      newContext: (o: object) => browser.newContext(o),
      close: async () => {},
    }) as unknown as Browser,
};
async function queued(id: string, config: Partial<RunConfigInput> = {}, seed = 7) {
  const c = runConfigSchema.parse({
    kind: 'journey',
    targetUrl: fake.baseUrl,
    totalSimulatedDays: 1,
    minutesPerRound: 60,
    personaIds: ['student', 'retired-volunteer'],
    ...config,
  });
  await createRun(db, id, c, seed, 'ops');
  await transition(db, id, 'queued', 'ops');
  return (await transition(db, id, 'preparing', 'w-test'))!;
}

describe('executeRun', () => {
  it('journey: guard → run → reports → cleanup → done, deterministic decisions, encrypted credentials', async () => {
    const run = await queued('jr1');
    const done = await executeRun(run, cfg, { ...keepOpen, db });
    expect(done.status).toBe('done');
    expect(done.summary).toMatchObject({ cleanup: { residualRows: 0 } });
    expect((await transitionsOf(db, 'jr1')).map((t) => t.to_status)).toEqual([
      'draft',
      'queued',
      'preparing',
      'running',
      'reporting',
      'cleaning',
      'done',
    ]);
    const funnel = (await getReport<FunnelReport>(db, 'jr1', 'funnel'))!;
    expect(funnel.meta).toMatchObject({
      seed: 7,
      catalogueVersion: data.catalogue.version,
      disclaimer: 'Simulation of 2 modelled personas, not a measurement of real users.',
    });
    expect(funnel.headline[0]).toMatchObject({ id: 'landing' });
    expect(await getReport<LoadReport>(db, 'jr1', 'load')).not.toBeNull();
    expect(await getReport(db, 'jr1', 'pricing')).not.toBeNull();
    const { rows } = await db.query('select credentials_enc from persona_memory');
    for (const r of rows) expect(r.credentials_enc).toMatch(/^v1\./);
    expect(fake.deps.store.users.size).toBe(0);
    expect(readdirSync(join(shots, 'jr1')).length).toBeGreaterThan(0);
    purgeScreenshots(shots, 'jr1');
    expect(existsSync(join(shots, 'jr1'))).toBe(false);
    // same seed + same target + same catalogue ⇒ same decisions
    const again = await queued('jr2');
    await executeRun(again, cfg, { ...keepOpen, db });
    const decisions = async (id: string) =>
      (await eventsOf(db, id)).map((e) => [e.personaId, e.useCaseId, e.action, e.simTime]);
    expect(await decisions('jr2')).toEqual(await decisions('jr1'));
  });

  it('refuses a production target without touching it', async () => {
    const prod = await liveFake({ env: 'production' });
    const run = await queued('pr1', { targetUrl: prod.baseUrl });
    const r = await executeRun(run, cfg, deps());
    const after = (await getRun(db, 'pr1'))!;
    expect(after).toMatchObject({
      status: 'refused',
      refusal_code: 'ORQEA_CONTRACT_MISSING:GET /api/admin/synthetic/target',
    });
    expect(r.status).toBe('preparing');
    await prod.close();
    const reporting = await liveFake();
    const run2 = await queued('pr2', { targetUrl: reporting.baseUrl });
    const lying = (async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (url.endsWith('/api/admin/synthetic/target'))
        return new Response(
          JSON.stringify({
            env: 'production',
            stripeMode: 'live',
            syntheticEnabled: true,
            version: 'x',
          }),
          { status: 200 },
        );
      return res;
    }) as typeof fetch;
    await executeRun(run2, cfg, deps({ fetchImpl: lying }));
    expect(await getRun(db, 'pr2')).toMatchObject({
      status: 'refused',
      refusal_code: 'PRODUCTION_ENV',
    });
    await reporting.close();
  });

  it('reports catalogue drift in the summary without failing (Orqea describes its API partially)', async () => {
    const run = await queued('dr1', {
      kind: 'volume',
      targetUsers: 1,
      personaIds: ['student'],
      totalSimulatedDays: 0.1,
    });
    const drifting = (async (url: string, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (!url.endsWith('/api')) return res;
      const body = (await res.json()) as { endpoints: unknown };
      const kept = flattenEndpoints(body.endpoints).filter((e) => e.path !== '/api/notes');
      return new Response(JSON.stringify({ message: 'Orqea API', endpoints: kept }), {
        status: 200,
      });
    }) as typeof fetch;
    const done = await executeRun(run, cfg, deps({ fetchImpl: drifting }));
    expect(done.status).toBe('done');
    expect(done.summary!.drift).toEqual([
      { useCase: 'notes-reminder', method: 'POST', path: '/api/notes' },
    ]);
  });

  it('Vigie replay: one persona in Chromium against the target, evidence per step, cleanup', async () => {
    const replay: VigieScenario = {
      schema: 1,
      sourceEnv: 'prod',
      targetEnv: 'dev',
      persona: { plan: 'free', device: 'desktop', locale: 'en' },
      steps: [
        { action: 'login', target: null },
        { action: 'use_feature', target: 'card.create' },
        { action: 'wait', target: 5 },
        {
          action: 'visit',
          target: '/board/:boardId',
          expect: { maxDurationMs: 60_000, status: 200 },
        },
        { action: 'visit', target: '/dashboard', expect: { maxDurationMs: 1 } },
      ],
    };
    const run = await queued('vr1', { kind: 'replay', replay, personaIds: [] });
    const done = await executeRun(run, cfg, { ...keepOpen, db });
    expect(done.status, done.error ?? '').toBe('done');
    const r = done.summary!.replay as {
      reproduced: boolean;
      steps: { ok: boolean; breached: boolean; status: number | null }[];
    };
    expect(r.steps.map((s) => [s.ok, s.breached])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [true, true], // nothing loads in 1 ms
    ]);
    expect(r.steps[3]!.status).toBe(200);
    expect(r.reproduced).toBe(true);
    expect(fake.deps.store.users.size).toBe(0);
    const click = await queued('vr2', {
      kind: 'replay',
      replay: { ...replay, steps: [{ action: 'click', target: 'x', expect: { status: 200 } }] },
    });
    const failed = await executeRun(click, cfg, { ...keepOpen, db });
    expect(failed.error).toContain('REPLAY_INCOMPLETE: step 0: click steps');
  });

  it('TARGET_NOT_READY: a browser run whose target never answers fails before touching accounts', async () => {
    const run = await queued('nr1', { targetUrl: 'http://127.0.0.1:1' });
    const quick = { ...cfg, readyTimeoutMs: 200, readyPollMs: 50 };
    const r = await executeRun(run, quick, deps());
    expect(r.status).toBe('failed');
    expect(r.error).toBe('TARGET_NOT_READY: http://127.0.0.1:1 did not answer within 200 ms');
    expect((await transitionsOf(db, 'nr1')).map((t) => t.to_status)).not.toContain('cleaning');
  });

  it('TARGET_UNREACHABLE: a navigation without response fails the run, replay or journey', async () => {
    // The browser goes offline once the target answered the readiness check.
    const offline = {
      ...keepOpen,
      db,
      launch: async () =>
        ({
          newContext: async (o: object) => {
            const c = await browser.newContext(o);
            await c.setOffline(true);
            return c;
          },
          close: async () => {},
        }) as unknown as Browser,
    };
    const replay: VigieScenario = {
      schema: 1,
      sourceEnv: 'prod',
      targetEnv: 'dev',
      persona: { plan: 'free', device: 'desktop', locale: 'en' },
      steps: [{ action: 'visit', target: '/', expect: { maxDurationMs: 340, status: 200 } }],
    };
    const r = await executeRun(await queued('ur1', { kind: 'replay', replay }), cfg, offline);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^TARGET_UNREACHABLE: step 0: vigie-visit: step 1: page\.goto: /);
    expect((r.summary!.replay as { reproduced: boolean }).reproduced).toBe(false);
    const j = await executeRun(await queued('ur2'), cfg, offline);
    expect(j.error).toMatch(/^TARGET_UNREACHABLE: landing: step 1: page\.goto: /);
  });

  it('personas pushed by Vigie are usable by runs', async () => {
    const student = data.personas.find((p) => p.id === 'student')!;
    await saveVigieSet(db, {
      setId: 'set1',
      sourceEnv: 'prod',
      targetEnv: 'dev',
      personas: [{ ...student, id: 'vigie-students' }],
    });
    const run = await queued('vp1', {
      kind: 'volume',
      targetUsers: 1,
      personaIds: ['vigie-students'],
      totalSimulatedDays: 0.1,
    });
    const done = await executeRun(run, cfg, deps());
    expect(done.status).toBe('done');
    expect(Object.keys(done.summary!.stages as object)).toEqual(['vigie-students-c1']);
  });

  it('named targets: the worker uses its own FIGURA_TARGETS; an unknown name is refused', async () => {
    const unknown = await queued('nt1', { target: 'recette' });
    const refused = await executeRun(unknown, cfg, deps());
    expect(refused).toMatchObject({ status: 'refused', refusal_code: 'TARGET_NOT_CONFIGURED' });
    expect(refused.refusal_message).toContain('FIGURA_TARGETS');
    const local = await queued('nt2', {
      kind: 'volume',
      target: 'local',
      targetUrl: 'http://ignored.example',
      targetUsers: 1,
      personaIds: ['student'],
      totalSimulatedDays: 0.1,
    });
    const named = { ...cfg, targets: { local: { api: fake.baseUrl, rewrite: {} } } };
    expect((await executeRun(local, named, deps())).status).toBe('done');
  });

  it('volume mode: API clones, rate-limited, load report with latencies', async () => {
    const run = await queued('vo1', {
      kind: 'volume',
      allowCheckout: true,
      targetUsers: 4,
      personaIds: ['student', 'agency'],
      totalSimulatedDays: 7,
    });
    const done = await executeRun(run, cfg, deps());
    expect(done.status).toBe('done');
    const load = (await getReport<LoadReport>(db, 'vo1', 'load'))!;
    expect(
      load.measuredLatency.find((l) => l.endpoint === 'POST /api/auth/register')!.count,
    ).toBeGreaterThanOrEqual(4);
    const clones = new Set((await eventsOf(db, 'vo1')).map((e) => e.personaId));
    expect([...clones].sort()).toEqual(['agency-c1', 'student-c1', 'student-c2', 'student-c3']);
    expect(await getReport(db, 'vo1', 'funnel')).toBeNull();
  });

  it('cancel stops the run, cleanup still runs', async () => {
    const run = await queued('ca1', { personaIds: ['project-manager'], totalSimulatedDays: 3 });
    const pending = executeRun(run, cfg, { ...keepOpen, db });
    await new Promise((r) => setTimeout(r, 400));
    await requestCancel(db, 'ca1', 'ops');
    const r = await pending;
    expect(r.status).toBe('cancelled');
    expect(fake.deps.store.users.size).toBe(0);
  });

  it('errors, residual rows and failed cleanups fail the run', async () => {
    const bad = await queued('er1', { fakeScenario: 'no-such-preset' });
    expect((await executeRun(bad, cfg, deps())).status).toBe('failed');
    expect((await getRun(db, 'er1'))!.error).toContain('PUT /__control/scenario/er1 → 400');
    const residual = (async (url: string, init?: RequestInit) =>
      url.endsWith('/cleanup')
        ? new Response('{"before":1,"after":1,"residualRows":1}', { status: 200 })
        : fetch(url, init)) as typeof fetch;
    const r1 = await queued('er2', {
      kind: 'volume',
      targetUsers: 1,
      personaIds: ['student'],
      totalSimulatedDays: 0.1,
    });
    expect((await executeRun(r1, cfg, deps({ fetchImpl: residual }))).error).toBe(
      'CLEANUP_INCOMPLETE: 1 residual rows',
    );
    const broken = (async (url: string, init?: RequestInit) =>
      url.endsWith('/cleanup')
        ? new Response('nope', { status: 500 })
        : fetch(url, init)) as typeof fetch;
    const r2 = await queued('er3', {
      kind: 'volume',
      targetUsers: 1,
      personaIds: ['student'],
      totalSimulatedDays: 0.1,
    });
    expect((await executeRun(r2, cfg, deps({ fetchImpl: broken }))).error).toContain(
      'CLEANUP_FAILED',
    );
  });
});

describe('worker loop', () => {
  it('tick claims queued runs, and fails a run whose execution crashes', async () => {
    expect(await tick(cfg, deps())).toBeNull();
    const c = runConfigSchema.parse({
      kind: 'volume',
      targetUrl: fake.baseUrl,
      personaIds: ['ghost'],
    });
    await createRun(db, 'tk1', c, 1, 'ops');
    await transition(db, 'tk1', 'queued', 'ops');
    const r = (await tick(cfg, deps()))!;
    expect(r).toMatchObject({ status: 'failed', error: 'Unknown personas: ghost' });
    await createRun(
      db,
      'tk2',
      runConfigSchema.parse({
        kind: 'volume',
        targetUrl: fake.baseUrl,
        targetUsers: 1,
        personaIds: ['student'],
        totalSimulatedDays: 0.1,
      }),
      1,
      'ops',
    );
    await transition(db, 'tk2', 'queued', 'ops');
    expect((await tick(cfg, deps()))!.status).toBe('done');
  });

  it('keeps the original row when even the failure transition is impossible', async () => {
    const c = runConfigSchema.parse({
      kind: 'volume',
      targetUrl: fake.baseUrl,
      personaIds: ['ghost'],
    });
    await createRun(db, 'tk3', c, 1, 'ops');
    await transition(db, 'tk3', 'queued', 'ops');
    const sabotage = {
      ...deps(),
      data: {
        ...data,
        get personas(): never {
          void db.query("update runs set status = 'done' where id = 'tk3'");
          throw new Error('boom');
        },
      },
    } as unknown as WorkerDeps;
    const r = (await tick(cfg, sabotage))!;
    expect(r.id).toBe('tk3');
  });

  it('recovers stale runs, cleaning up their data', async () => {
    const run = await queued('st1');
    await db.query("update runs set heartbeat_at = now() - interval '1 hour'");
    expect(await recoverStale(cfg, deps(), 60)).toEqual(['st1']);
    expect((await getRun(db, 'st1'))!.error).toBe('worker lost; cleanup residualRows=0');
    const run2 = await queued('st2', { targetUrl: 'http://127.0.0.1:1' });
    await db.query("update runs set heartbeat_at = now() - interval '1 hour' where id = 'st2'");
    await recoverStale(cfg, deps(), 60);
    expect((await getRun(db, 'st2'))!.error).toContain('cleanup failed');
    expect(run.id).toBe('st1');
    expect(run2.id).toBe('st2');
  });

  it('workLoop polls until aborted', async () => {
    const ac = new AbortController();
    const loop = workLoop(cfg, deps(), ac.signal, 10);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await loop;
    expect(ac.signal.aborted).toBe(true);
  });
});
