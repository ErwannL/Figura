import { claimNext, staleRuns, transition, type RunRow } from '../app/db/runs.js';
import { executeRun, type WorkerConfig, type WorkerDeps } from './runner.js';
import { OrqeaClient } from './target/client.js';
import { purgeExplorerShots } from './explorer/shots.js';

/** Runs abandoned by a dead worker are failed, and their synthetic data cleaned up (best effort). */
export async function recoverStale(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  olderThanSeconds: number,
): Promise<string[]> {
  const stale = await staleRuns(deps.db, olderThanSeconds);
  for (const run of stale) {
    const client = new OrqeaClient({
      baseUrl: run.config.targetUrl.replace(/\/$/, ''),
      serviceSecret: cfg.serviceSecret,
      runId: run.id,
      fetchImpl: deps.fetchImpl,
      nowS: deps.nowS,
    });
    const note = await client.cleanup().then(
      (r) => `worker lost; cleanup residualRows=${r.residualRows}`,
      (e: Error) => `worker lost; cleanup failed: ${e.message}`,
    );
    await transition(deps.db, run.id, 'failed', cfg.workerId, note, { error: note });
  }
  return stale.map((r) => r.id);
}

/** One iteration: claim and execute the oldest queued run. */
export async function tick(cfg: WorkerConfig, deps: WorkerDeps): Promise<RunRow | null> {
  const run = await claimNext(deps.db, cfg.workerId);
  if (!run) return null;
  try {
    return await executeRun(run, cfg, deps);
  } catch (e) {
    // Last resort (e.g. database hiccup mid-run): never leave a run hanging in an active state.
    const message = (e as Error).message;
    return transition(deps.db, run.id, 'failed', cfg.workerId, message, { error: message }).catch(
      () => run,
    );
  }
}

export async function workLoop(
  cfg: WorkerConfig,
  deps: WorkerDeps,
  signal: AbortSignal,
  pollMs: number,
): Promise<void> {
  await recoverStale(cfg, deps, 600);
  let purged = 0;
  while (!signal.aborted) {
    // Explorer screenshot retention, at most hourly.
    if (Date.now() - purged > 3_600_000) {
      purgeExplorerShots(cfg.screenshotsDir, cfg.explorerRetentionDays, Date.now());
      purged = Date.now();
    }
    const ran = await tick(cfg, deps);
    if (!ran) await new Promise((r) => setTimeout(r, pollMs));
  }
}
