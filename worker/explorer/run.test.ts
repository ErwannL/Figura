import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb } from '../../app/test-helpers/db.js';
import type { Db } from '../../app/db/pool.js';
import { createRun, getRun, requestCancel, transition, transitionsOf } from '../../app/db/runs.js';
import { getReport } from '../../app/db/misc.js';
import { dataKey } from '../../shared/crypto.js';
import { repoRoot } from '../../shared/paths.js';
import { runConfigSchema, type RunConfigInput } from '../../shared/run-config.js';
import { SECRET } from '../../fake-orqea/test-helpers/fake.js';
import { liveFake } from '../test-helpers/live-fake.js';
import { loadSimData } from '../data.js';
import { executeRun, type WorkerConfig, type WorkerDeps } from '../runner.js';
import type { ExploreReport } from './report.js';
import { deviceContext, explorerPersona, missionRunner, publicApiOrigin } from './run.js';

const data = loadSimData(repoRoot());
let db: Db;
let fake: Awaited<ReturnType<typeof liveFake>>;
const shots = mkdtempSync(join(tmpdir(), 'explore-run-'));
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
  explorerPause: { min: 0, max: 0 },
};
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db?.end();
  db = await testDb();
  fake = await liveFake();
});
afterEach(async () => fake.close());

/** Each run launches (and closes) its own Chromium, as the worker does. */
const deps = (o: Partial<WorkerDeps> = {}): WorkerDeps => ({
  db,
  data,
  fetchImpl: fetch,
  launch: () => chromium.launch({ headless: true }),
  nowS: () => Math.floor(Date.now() / 1000),
  ...o,
});

async function queued(id: string, explorer: object = {}, config: Partial<RunConfigInput> = {}) {
  const c = runConfigSchema.parse({
    kind: 'explore',
    targetUrl: fake.baseUrl,
    explorer: { maxActions: 8, ...explorer },
    ...config,
  });
  await createRun(db, id, c, 5, 'ops');
  await transition(db, id, 'queued', 'ops');
  return transition(db, id, 'preparing', 'w-test');
}

describe('explorer runs (worker)', () => {
  it('two devices in parallel: synthetic accounts, seed data, screenshots, report, progress, cleanup', async () => {
    const run = await queued('ex1', {
      devices: ['desktop', 'mobile'],
      sessions: 2,
      seedData: true,
    });
    const done = await executeRun(run, cfg, deps());
    expect(done.error).toBeNull();
    expect(done.status, `${done.error}`).toBe('done');
    expect((await transitionsOf(db, 'ex1')).map((t) => t.to_status)).toEqual([
      'draft',
      'queued',
      'preparing',
      'running',
      'cleaning',
      'done',
    ]);
    const report = (await getReport<ExploreReport>(db, 'ex1', 'explore'))!;
    expect(report).toMatchObject({
      type: 'explore',
      runId: 'ex1',
      seed: 5,
      cleanup: { residualRows: 0 },
    });
    expect(report.sessions.map((s) => [s.device, s.slot, s.account, s.stoppedBy, s.steps])).toEqual(
      [
        ['desktop', 0, 'synth+ex1-explorer-desktop-0@synthetic.invalid', 'budget', 8],
        ['mobile', 0, 'synth+ex1-explorer-mobile-0@synthetic.invalid', 'budget', 8],
      ],
    );
    expect(report.statesByDevice.desktop).toBeGreaterThan(0);
    expect(report.gallery.length).toBeGreaterThan(0);
    for (const s of report.screenshots) expect(existsSync(join(shots, 'ex1', s.file))).toBe(true);
    for (const a of report.anomalies)
      expect(a.replay).toMatchObject({ seed: 5, device: a.device, untilStep: a.step });
    // Seed data went through the catalogue's own use cases.

    const progress = (await getRun(db, 'ex1'))!.progress as { sessions: unknown[]; states: number };
    expect(progress.sessions).toHaveLength(2);
    expect(progress.states).toBeGreaterThan(0);
    expect(done.summary).toMatchObject({ explore: { states: progress.states } });
    // Nothing secret in the stored report.
    const text = JSON.stringify(report);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/x-synthetic-run|eyJ[\w-]+\.[\w-]+\./i);
  });

  it('replays one session up to a step with the same seed and device (human pace)', async () => {
    const run = await queued('ex2', { replay: { device: 'mobile', slot: 0, untilStep: 3 } });
    const t0 = Date.now();
    const done = await executeRun(run, { ...cfg, explorerPause: undefined }, deps());
    // Three pauses of 400–2 500 ms between actions.
    expect(Date.now() - t0).toBeGreaterThan(1200);
    const report = (await getReport<ExploreReport>(db, 'ex2', 'explore'))!;
    expect(done.status, `${done.error}`).toBe('done');
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({ device: 'mobile', slot: 0, steps: 3 });
  });

  it('refuses a live-Stripe target and a non-synthetic one, without touching them', async () => {
    await fake.close();
    fake = await liveFake({ stripeMode: 'live' });
    await executeRun(await queued('ex3'), cfg, deps());
    expect(await getRun(db, 'ex3')).toMatchObject({
      status: 'refused',
      refusal_code: 'STRIPE_LIVE',
    });
    await fake.close();
    fake = await liveFake({ syntheticEnabled: false });
    await executeRun(await queued('ex4'), cfg, deps());
    const ex4 = (await getRun(db, 'ex4'))!;
    // With synthetic mode off, Orqea's admin API answers 404 (contract §3): refused all the same.
    expect(`${ex4.status} ${ex4.refusal_code}`).toBe(
      'refused ORQEA_CONTRACT_MISSING:GET /api/admin/synthetic/target',
    );
    expect((await transitionsOf(db, 'ex4')).map((t) => t.to_status)).not.toContain('cleaning');
  });

  it('cleanup runs even when the exploration throws', async () => {
    const run = await queued('ex5');
    const failed = await executeRun(
      run,
      cfg,
      deps({
        launch: async () => {
          throw new Error('no chromium');
        },
      }),
    );
    expect(failed).toMatchObject({ status: 'failed', error: 'no chromium' });
    expect((await transitionsOf(db, 'ex5')).map((t) => t.to_status)).toContain('cleaning');
    expect(failed.summary).toMatchObject({ cleanup: { residualRows: 0 } });
    expect(await getReport(db, 'ex5', 'explore')).toBeNull();
  });

  it('cancel stops the sessions, closes the browser and still cleans up', async () => {
    const run = await queued('ex6', { maxActions: 400 });
    const pending = executeRun(run, cfg, deps());
    await new Promise((r) => setTimeout(r, 3000));
    await requestCancel(db, 'ex6', 'ops');
    const done = await pending;
    expect(done.status, `${done.error}`).toBe('cancelled');
    expect(done.summary).toMatchObject({ cleanup: { residualRows: 0 } });
    const report = (await getReport<ExploreReport>(db, 'ex6', 'explore'))!;
    expect(report.sessions[0]!.stoppedBy).toBe('cancel');
  });

  it('residual rows after cleanup are an anomaly of the run, which fails', async () => {
    const residual = (async (url: string, init?: RequestInit) =>
      String(url).endsWith('/cleanup')
        ? new Response('{"before":1,"after":1,"residualRows":2}', { status: 200 })
        : fetch(url, init)) as typeof fetch;
    const done = await executeRun(await queued('ex7'), cfg, deps({ fetchImpl: residual }));
    expect(`${done.status} ${done.error}`).toBe('failed CLEANUP_INCOMPLETE: 2 residual rows');
    const report = (await getReport<ExploreReport>(db, 'ex7', 'explore'))!;
    expect(report.anomalies[0]).toMatchObject({
      type: 'cleanup-residual',
      severity: 'critical',
      message: '2 synthetic rows left after cleanup',
    });
  });

  it('a cleanup that cannot be called fails the run and is an anomaly of the report', async () => {
    const down = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/cleanup')) throw new Error('connection refused');
      return fetch(url, init);
    }) as typeof fetch;
    const done = await executeRun(await queued('ex9'), cfg, deps({ fetchImpl: down }));
    expect(done.error).toMatch(/^CLEANUP_FAILED: /);
    const report = (await getReport<ExploreReport>(db, 'ex9', 'explore'))!;
    expect(report.cleanup).toBeNull();
    expect(report.anomalies[0]).toMatchObject({ type: 'cleanup-residual', message: done.error });
  });

  it('when every session fails its account setup the run fails, and still reports', async () => {
    const done = await executeRun(
      await queued('ex8', {}, { fakeScenario: 'unclear-signup' }),
      cfg,
      deps(),
    );
    const report = (await getReport<ExploreReport>(db, 'ex8', 'explore'))!;
    // A run that explored nothing is not "done": the target could not even be signed up on.
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^every session failed: setup: /);
    expect(report.sessions[0]).toMatchObject({ stoppedBy: 'error', steps: 0 });
    expect(report.sessions[0]!.error).toMatch(/^setup: /);
    // The failing page is kept as evidence (a blank or blocked page explains the failure).
    expect(report.screenshots.some((s) => s.kind === 'setup')).toBe(true);
  });
});

describe('explorer run helpers', () => {
  it('a mission runs its prerequisites then its use case; a failure is "not done"', async () => {
    const calls: string[] = [];
    const ok = missionRunner(
      {
        prerequisites: async (id) => void calls.push(`pre ${id}`),
        attempt: async (uc) => (calls.push(uc.id), { ok: true }) as never,
      },
      data.catalogue,
    );
    expect(await ok('create-card')).toBe(true);
    expect(calls).toEqual(['pre create-card', 'create-card']);
    const broken = missionRunner(
      {
        prerequisites: async () => {
          throw new Error('no board');
        },
        attempt: async () => ({ ok: true }) as never,
      },
      data.catalogue,
    );
    expect(await broken('create-card')).toBe(false);
  });

  it('device contexts come from the catalogue (Playwright profiles for tablet and mobile)', () => {
    expect(deviceContext('desktop')).toEqual({
      viewport: { width: 1440, height: 900 },
      isMobile: false,
      hasTouch: false,
    });
    expect(deviceContext('tablet')).toMatchObject({
      isMobile: true,
      hasTouch: true,
      viewport: { width: 810 },
    });
    expect(deviceContext('mobile')).not.toHaveProperty('defaultBrowserType');
  });
  it('explorer personas are English, per device and slot, without assistive profile', () => {
    const p = explorerPersona(data.personas, { device: 'tablet', slot: 1, maxActions: 1 });
    expect(p).toMatchObject({ id: 'explorer-tablet-1', locale: 'en', device: 'mobile' });
    expect(p.assistive).toBeUndefined();
    const fr = data.personas.filter((x) => x.locale === 'fr');
    expect(explorerPersona(fr, { device: 'desktop', slot: 0, maxActions: 1 })).toMatchObject({
      locale: 'en',
      device: 'desktop',
    });
  });
  it('the API origin as the page sees it', () => {
    const t = {
      api: 'http://backend:5001',
      web: 'http://frontend:3001',
      browserBase: 'http://localhost:3001',
      rewrite: { 'http://localhost:5001': 'http://backend:5001' },
    };
    expect(publicApiOrigin(t)).toBe('http://localhost:5001');
    expect(publicApiOrigin({ ...t, rewrite: {} })).toBe('http://backend:5001');
  });
});
