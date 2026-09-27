import type { Browser } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../app/db/pool.js';
import { EventWriter } from '../app/db/events.js';
import { allPersonas } from '../app/db/vigie.js';
import { DbMemoryStore } from '../app/db/memory.js';
import { heartbeat, isCancelRequested, transition, type RunRow } from '../app/db/runs.js';
import type { Plan } from '../shared/plans.js';
import {
  effectiveTarget,
  TARGET_NOT_CONFIGURED,
  type EffectiveTarget,
  type Targets,
} from '../shared/targets.js';
import { simulate, type SimulationSummary } from './engine/simulate.js';
import { buildReports } from './build-reports.js';
import type { SimData } from './data.js';
import {
  apiDrivers,
  browserDrivers,
  clonesOf,
  initialVars,
  newCredentials,
  selectPersonas,
} from './modes.js';
import { replayScenario } from './replay.js';
import { exploreRun } from './explorer/run.js';
import { withCleanup, type ExploreReport } from './explorer/report.js';
import { planSessions, type ExplorerConfig } from '../shared/explorer.js';
import { saveReport } from '../app/db/misc.js';
import {
  OrqeaClient,
  type CleanupResult,
  type Endpoint,
  type TargetInfo,
} from './target/client.js';
import { checkDrift, type DriftReport } from './target/drift.js';
import { guardTarget, REFUSAL_MESSAGES } from './target/guard.js';
import { waitReady } from './target/ready.js';

export interface WorkerConfig {
  workerId: string;
  serviceSecret: string;
  dataKey: Buffer;
  screenshotsDir: string;
  localHosts: string[];
  productionHosts: string[];
  caps: { accounts: number; requestsPerSecond: number; rows: number };
  stepTimeoutMs: number;
  cancelPollMs: number;
  /** Rough rows a synthetic account creates on the target (for the VOLUME_CAP estimate). */
  rowsPerAccount: number;
  /** Named Orqea targets (FIGURA_TARGETS): the worker's copy is authoritative for URLs and rewrites. */
  targets: Targets;
  /** Browser runs wait this long for the web app and API to answer (FIGURA_READY_TIMEOUT_MS). */
  readyTimeoutMs: number;
  readyPollMs: number;
  /** Explorer screenshots older than this are purged by the work loop (FIGURA_EXPLORER_RETENTION_DAYS). */
  explorerRetentionDays: number;
  /** Pause between explorer actions; tests shorten it (the default is the human 400–2 500 ms). */
  explorerPause?: { min: number; max: number };
}

export interface WorkerDeps {
  db: Db;
  data: SimData;
  fetchImpl: typeof fetch;
  launch: () => Promise<Browser>;
  nowS: () => number;
}

interface Prepared {
  client: OrqeaClient;
  target: EffectiveTarget;
  info: TargetInfo;
  endpoints: Endpoint[];
  plans: Plan[];
  /** Catalogue API steps `GET /api` does not describe — reported, never fatal (see drift.ts). */
  drift: DriftReport['missing'];
}

/** preparing: guard (refusal = nothing touched), then drift check. Returns null if refused. */
async function prepare(
  run: RunRow,
  cfg: WorkerConfig,
  deps: WorkerDeps,
  client: OrqeaClient,
  target: EffectiveTarget,
): Promise<Prepared | null> {
  const c = run.config;
  const personas = selectPersonas(deps.data.personas, c.personaIds);
  const accounts =
    c.kind === 'replay'
      ? 1
      : c.kind === 'explore'
        ? planSessions(c.explorer as ExplorerConfig).length
        : c.kind === 'journey'
          ? personas.length
          : clonesOf(personas, c.targetUsers).length;
  const guard = await guardTarget(
    {
      targetUrl: target.api,
      otherUrls: [target.web, ...Object.values(target.rewrite)],
      allowRemote: c.allowRemote,
      confirmHost: c.confirmHost,
      localHosts: cfg.localHosts,
      productionHosts: cfg.productionHosts,
      requested: {
        accounts,
        requestsPerSecond: c.kind === 'volume' ? cfg.caps.requestsPerSecond : 5,
        rows: accounts * cfg.rowsPerAccount,
      },
      caps: cfg.caps,
      refuseLiveStripe: c.kind === 'explore',
    },
    client,
  );
  if (!guard.ok) {
    await transition(deps.db, run.id, 'refused', cfg.workerId, guard.code, {
      refusal_code: guard.code,
      refusal_message: guard.message,
    });
    return null;
  }
  const drift = checkDrift(deps.data.catalogue, guard.endpoints).missing;
  return {
    client,
    target,
    info: guard.info,
    endpoints: guard.endpoints,
    plans: guard.plans,
    drift,
  };
}

export async function executeRun(
  run: RunRow,
  cfg: WorkerConfig,
  base: WorkerDeps,
): Promise<RunRow> {
  // Personas pushed by Vigie are usable like the catalogue's (docs/VIGIE.md).
  const personas = await allPersonas(base.db, base.data.personas);
  const deps = { ...base, data: { ...base.data, personas } };
  const target = effectiveTarget(run.config, cfg.targets);
  if (!target) {
    return transition(deps.db, run.id, 'refused', cfg.workerId, TARGET_NOT_CONFIGURED, {
      refusal_code: TARGET_NOT_CONFIGURED,
      refusal_message: REFUSAL_MESSAGES.TARGET_NOT_CONFIGURED,
    });
  }
  const client = new OrqeaClient({
    baseUrl: target.api.replace(/\/$/, ''),
    serviceSecret: cfg.serviceSecret,
    runId: run.id,
    fetchImpl: deps.fetchImpl,
    nowS: deps.nowS,
  });
  // Browser runs: the web app and the API must answer first (a dev server may still be compiling).
  if (run.config.kind !== 'volume') {
    const notReady = await waitReady([target.web, target.api], {
      fetchImpl: deps.fetchImpl,
      timeoutMs: cfg.readyTimeoutMs,
      pollMs: cfg.readyPollMs,
    });
    if (notReady) {
      const error = `TARGET_NOT_READY: ${notReady} did not answer within ${cfg.readyTimeoutMs} ms`;
      return transition(deps.db, run.id, 'failed', cfg.workerId, error, { error });
    }
  }
  const prepared = await prepare(run, cfg, deps, client, target);
  if (!prepared) return run;
  if (run.config.kind === 'explore') return exploreAndFinish(run, cfg, deps, prepared);
  let error: string | null = null;
  let summary: Record<string, unknown> = { drift: prepared.drift };
  let cancelled = false;
  try {
    if (run.config.kind === 'replay') {
      const replay = await replayRun(run, cfg, deps, prepared);
      summary = { ...summary, replay };
      if (replay.unreachable) error = `TARGET_UNREACHABLE: ${replay.unreachable}`;
      else if (replay.incomplete) error = `REPLAY_INCOMPLETE: ${replay.incomplete}`;
      return await finish(run, cfg, deps, prepared.client, { error, summary, cancelled });
    }
    const result = await simulateRun(run, cfg, deps, prepared);
    cancelled = result.summary.stopped;
    summary = { ...summary, ...result.summary, plans: result.plans.length };
    if (!cancelled) {
      await transition(deps.db, run.id, 'reporting', cfg.workerId);
      const started = run.started_at ?? new Date();
      await buildReports(
        deps.db,
        run,
        deps.data,
        prepared,
        result.plans,
        Date.now() - started.getTime(),
      );
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return finish(run, cfg, deps, prepared.client, { error, summary, cancelled });
}

/** Explorer run; cleanup always runs, and its outcome goes into the report. */
async function exploreAndFinish(
  run: RunRow,
  cfg: WorkerConfig,
  deps: WorkerDeps,
  prepared: Prepared,
): Promise<RunRow> {
  let error: string | null = null;
  let cancelled = false;
  let report: ExploreReport | null = null;
  const summary: Record<string, unknown> = { drift: prepared.drift };
  try {
    if (run.config.fakeScenario !== null)
      await prepared.client.setScenario(run.config.fakeScenario);
    const r = await exploreRun(run, cfg, deps, prepared);
    report = r.report;
    cancelled = r.cancelled;
    summary.explore = {
      states: r.report.sessions.reduce((n, s) => n + s.states, 0),
      anomalies: r.report.anomalies.length,
      screenshots: r.report.screenshots.length,
    };
  } catch (e) {
    error = (e as Error).message;
  }
  const final = await finish(run, cfg, deps, prepared.client, { error, summary, cancelled });
  if (report) {
    const cleanup = (final.summary?.cleanup as CleanupResult | undefined) ?? null;
    await saveReport(deps.db, run.id, 'explore', withCleanup(report, cleanup, final.error));
  }
  return final;
}

/** A Vigie scenario, one persona, step by step in a browser (docs/VIGIE.md). */
async function replayRun(run: RunRow, cfg: WorkerConfig, deps: WorkerDeps, prepared: Prepared) {
  await transition(deps.db, run.id, 'running', cfg.workerId, null, {
    catalogue_version: deps.data.catalogue.version,
    weights_version: deps.data.weights.version,
    target_version: prepared.info.version,
  });
  const drivers = await browserDrivers(prepared.target, run.id, deps.data, {
    launch: deps.launch,
    runHeader: () => prepared.client.runHeader(),
    screenshotsDir: cfg.screenshotsDir,
    stepTimeoutMs: cfg.stepTimeoutMs,
  });
  try {
    return await replayScenario(run.id, run.config.replay!, {
      catalogue: deps.data.catalogue,
      openDriver: drivers.openDriver,
      requestVerifyUrl: (email) => prepared.client.requestVerifyUrl(email),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  } finally {
    await drivers.close();
  }
}

async function simulateRun(
  run: RunRow,
  cfg: WorkerConfig,
  deps: WorkerDeps,
  prepared: Prepared,
): Promise<{ summary: SimulationSummary; plans: Plan[] }> {
  const c = run.config;
  if (c.fakeScenario !== null) await prepared.client.setScenario(c.fakeScenario);
  await transition(deps.db, run.id, 'running', cfg.workerId, null, {
    catalogue_version: deps.data.catalogue.version,
    weights_version: deps.data.weights.version,
    target_version: prepared.info.version,
  });
  const plans = prepared.plans;
  const selected = selectPersonas(deps.data.personas, c.personaIds);
  const personas = c.kind === 'journey' ? selected : clonesOf(selected, c.targetUsers);
  const runHeader = () => prepared.client.runHeader();
  const drivers =
    c.kind === 'journey'
      ? await browserDrivers(prepared.target, run.id, deps.data, {
          launch: deps.launch,
          runHeader,
          screenshotsDir: cfg.screenshotsDir,
          stepTimeoutMs: cfg.stepTimeoutMs,
        })
      : apiDrivers(prepared.target, {
          runHeader,
          fetchImpl: deps.fetchImpl,
          requestsPerSecond: cfg.caps.requestsPerSecond,
        });
  let stop = false;
  const poll = setInterval(() => {
    void isCancelRequested(deps.db, run.id).then((v) => (stop = stop || v));
    void heartbeat(deps.db, run.id);
  }, cfg.cancelPollMs);
  const writer = new EventWriter(deps.db, run.id);
  try {
    const summary = await simulate(
      {
        seed: run.seed,
        personas,
        start: new Date(c.startAt),
        totalSimulatedDays: c.totalSimulatedDays,
        minutesPerRound: c.minutesPerRound,
        timeConfig: deps.data.time,
      },
      {
        catalogue: deps.data.catalogue,
        weights: deps.data.weights,
        target: {
          requestVerifyUrl: (email) => prepared.client.requestVerifyUrl(email),
          plans: async () => plans,
        },
        recorder: writer,
        openDriver: drivers.openDriver,
        shouldStop: () => stop,
        now: () => new Date(),
        allowCheckout: c.allowCheckout && prepared.info.stripeMode === 'test',
        memoryStore: new DbMemoryStore(deps.db, run.id, cfg.dataKey),
        newCredentials: newCredentials(run.id),
        initialVars: initialVars(run.id),
      },
    );
    return { summary, plans };
  } finally {
    clearInterval(poll);
    await writer.flush();
    await drivers.close();
  }
}

/** cleaning always runs; residual rows on the target mean a failed run. */
async function finish(
  run: RunRow,
  cfg: WorkerConfig,
  deps: WorkerDeps,
  client: OrqeaClient,
  o: { error: string | null; summary: Record<string, unknown>; cancelled: boolean },
): Promise<RunRow> {
  await transition(deps.db, run.id, 'cleaning', cfg.workerId);
  let error = o.error;
  try {
    const cleanup = await client.cleanup();
    o.summary.cleanup = cleanup;
    if (cleanup.residualRows > 0)
      error = error ?? `CLEANUP_INCOMPLETE: ${cleanup.residualRows} residual rows`;
  } catch (e) {
    error = error ?? `CLEANUP_FAILED: ${(e as Error).message}`;
  }
  const final = error ? 'failed' : o.cancelled ? 'cancelled' : 'done';
  return transition(deps.db, run.id, final, cfg.workerId, error, { error, summary: o.summary });
}

/** Deleting a run purges its screenshots too. */
export function purgeScreenshots(screenshotsDir: string, runId: string): void {
  rmSync(join(screenshotsDir, runId), { recursive: true, force: true });
}
