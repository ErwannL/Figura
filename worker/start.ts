import { join } from 'node:path';
import { hostname } from 'node:os';
import { createPool, migrate } from '../app/db/pool.js';
import { dataKey } from '../shared/crypto.js';
import { repoRoot } from '../shared/paths.js';
import { parseTargets } from '../shared/targets.js';
import { loadSimData } from './data.js';
import { launchBrowser } from './drivers/browser.js';
import { workLoop } from './loop.js';
import type { WorkerConfig, WorkerDeps } from './runner.js';
import type { Db } from '../app/db/pool.js';

type Env = Record<string, string | undefined>;
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function workerConfigFromEnv(env: Env): {
  cfg: WorkerConfig;
  databaseUrl: string;
  pollMs: number;
  chromium: string | undefined;
} {
  const serviceSecret = env.SYNTHETIC_SERVICE_SECRET ?? '';
  if (serviceSecret.length < 32)
    throw new Error('SYNTHETIC_SERVICE_SECRET must be at least 32 characters');
  const databaseUrl = env.FIGURA_DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('FIGURA_DATABASE_URL must be set');
  return {
    cfg: {
      workerId: env.FIGURA_WORKER_ID ?? `worker-${hostname()}`,
      serviceSecret,
      dataKey: dataKey(env.FIGURA_DATA_KEY ?? ''),
      screenshotsDir: env.FIGURA_SCREENSHOTS_DIR ?? 'data/screenshots',
      localHosts: list(env.FIGURA_LOCAL_TARGET_HOSTS),
      productionHosts: list(env.FIGURA_PRODUCTION_HOSTS),
      caps: {
        accounts: Number(env.FIGURA_MAX_ACCOUNTS ?? 500),
        requestsPerSecond: Number(env.FIGURA_MAX_RPS ?? 20),
        rows: Number(env.FIGURA_MAX_ROWS ?? 100000),
      },
      stepTimeoutMs: Number(env.FIGURA_STEP_TIMEOUT_MS ?? 8000),
      cancelPollMs: 1000,
      rowsPerAccount: 50,
      targets: parseTargets(env.FIGURA_TARGETS),
      readyTimeoutMs: Number(env.FIGURA_READY_TIMEOUT_MS ?? 120_000),
      readyPollMs: 2000,
      explorerRetentionDays: Number(env.FIGURA_EXPLORER_RETENTION_DAYS ?? 14),
    },
    databaseUrl,
    pollMs: Number(env.FIGURA_POLL_MS ?? 2000),
    chromium: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  };
}

export function workerDeps(db: Db, root: string, chromium: string | undefined): WorkerDeps {
  return {
    db,
    data: loadSimData(root),
    fetchImpl: fetch,
    launch: () => launchBrowser(chromium),
    nowS: () => Math.floor(Date.now() / 1000),
  };
}

export async function start(env: Env, signal: AbortSignal): Promise<void> {
  const { cfg, databaseUrl, pollMs, chromium } = workerConfigFromEnv(env);
  const root = repoRoot();
  const db = createPool(databaseUrl);
  try {
    await migrate(db, join(root, 'app', 'db', 'migrations'));
    await workLoop(cfg, workerDeps(db, root, chromium), signal, pollMs);
  } finally {
    await db.end();
  }
}
