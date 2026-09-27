import { describe, expect, it } from 'vitest';
import { TEST_DB_URL, testDb } from '../app/test-helpers/db.js';
import { start, workerConfigFromEnv, workerDeps } from './start.js';
import { repoRoot } from '../shared/paths.js';
import type { Db } from '../app/db/pool.js';

const env = {
  SYNTHETIC_SERVICE_SECRET: 's'.repeat(32),
  FIGURA_DATABASE_URL: TEST_DB_URL,
  FIGURA_DATA_KEY: 'd'.repeat(32),
};
describe('worker start', () => {
  it('reads config with safe caps', () => {
    const c = workerConfigFromEnv(env);
    expect(c.cfg.caps).toEqual({ accounts: 500, requestsPerSecond: 20, rows: 100000 });
    expect(c.cfg.localHosts).toEqual([]);
    expect(c.cfg.targets).toEqual({});
    expect(c.cfg.explorerRetentionDays).toBe(14);
    expect(
      workerConfigFromEnv({ ...env, FIGURA_TARGETS: '{"local":{"api":"http://backend:5001"}}' }).cfg
        .targets,
    ).toEqual({ local: { api: 'http://backend:5001', rewrite: {} } });
    expect(c.chromium).toBeUndefined();
    const o = workerConfigFromEnv({
      ...env,
      FIGURA_WORKER_ID: 'w',
      FIGURA_LOCAL_TARGET_HOSTS: 'fake-orqea, x',
      FIGURA_PRODUCTION_HOSTS: 'app.orqea.com',
      FIGURA_MAX_ACCOUNTS: '1',
      FIGURA_MAX_RPS: '2',
      FIGURA_MAX_ROWS: '3',
      FIGURA_STEP_TIMEOUT_MS: '4',
      FIGURA_POLL_MS: '5',
      FIGURA_SCREENSHOTS_DIR: '/s',
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/c',
    });
    expect(o).toMatchObject({
      pollMs: 5,
      chromium: '/c',
      cfg: {
        workerId: 'w',
        localHosts: ['fake-orqea', 'x'],
        productionHosts: ['app.orqea.com'],
        caps: { accounts: 1, requestsPerSecond: 2, rows: 3 },
        stepTimeoutMs: 4,
        screenshotsDir: '/s',
      },
    });
  });
  it('rejects missing secrets', () => {
    expect(() => workerConfigFromEnv({ ...env, SYNTHETIC_SERVICE_SECRET: '' })).toThrow(
      'SYNTHETIC_SERVICE_SECRET',
    );
    expect(() => workerConfigFromEnv({})).toThrow('SYNTHETIC_SERVICE_SECRET');
    expect(() =>
      workerConfigFromEnv({ SYNTHETIC_SERVICE_SECRET: env.SYNTHETIC_SERVICE_SECRET }),
    ).toThrow('FIGURA_DATABASE_URL');
    expect(() => workerConfigFromEnv({ ...env, FIGURA_DATA_KEY: undefined })).toThrow(
      'FIGURA_DATA_KEY',
    );
  });
  it('builds real dependencies (browser launcher, clock)', async () => {
    const d = workerDeps({} as Db, repoRoot(), undefined);
    expect(Math.abs(d.nowS() - Date.now() / 1000)).toBeLessThan(5);
    const b = await d.launch();
    await b.close();
  });
  it('migrates and loops until aborted', async () => {
    // An empty database: runs other test files left queued must not be claimed here.
    await (await testDb()).end();
    const ac = new AbortController();
    const p = start({ ...env, FIGURA_POLL_MS: '10' }, ac.signal);
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await p;
    expect(ac.signal.aborted).toBe(true);
  });
});
