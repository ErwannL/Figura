import { parseTargets, type Targets } from '../shared/targets.js';

type Env = Record<string, string | undefined>;

export interface AppConfig {
  databaseUrl: string;
  sessionSecret: string;
  ssoSecret: string;
  appId: string;
  consoleOrigins: string[];
  loopbackOnly: boolean;
  crossSiteCookie: boolean;
  sessionTtlMinutes: number;
  port: number;
  host: string;
  screenshotsDir: string;
  uiDir: string;
  maxRunsListed: number;
  /** Named Orqea targets (FIGURA_TARGETS). */
  targets: Targets;
  /**
   * Bearer of the Vigie service API (`FIGURA_VIGIE_SECRET`); null when absent or shorter than 32
   * characters, which closes every /api/vigie/* route (401).
   */
  vigieSecret: string | null;
  /** Public link of the « Back to Orqea » button (`FIGURA_ORQEA_URL`), exposed on /health. */
  orqeaUrl: string;
}

function secret(env: Env, key: string): string {
  const v = env[key] ?? '';
  if (v.length < 32) throw new Error(`${key} must be set to at least 32 characters`);
  return v;
}

export function appConfigFromEnv(env: Env, defaults: { uiDir: string }): AppConfig {
  const sessionSecret = secret(env, 'FIGURA_SESSION_SECRET');
  const ssoSecret = secret(env, 'FIGURA_SSO_SECRET');
  if (sessionSecret === ssoSecret)
    throw new Error('FIGURA_SSO_SECRET must differ from FIGURA_SESSION_SECRET');
  const vigie = env.FIGURA_VIGIE_SECRET ?? '';
  const vigieSecret = vigie.length >= 32 ? vigie : null;
  if (vigieSecret !== null && [sessionSecret, ssoSecret].includes(vigieSecret))
    throw new Error('FIGURA_VIGIE_SECRET must differ from every other secret');
  const databaseUrl = env.FIGURA_DATABASE_URL ?? '';
  if (!databaseUrl) throw new Error('FIGURA_DATABASE_URL must be set');
  // Orqea's admin console runs on :3002; the fake console on :4100.
  const origins = (env.FIGURA_CONSOLE_ORIGINS ?? 'http://localhost:4100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of origins) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o))
      throw new Error(`FIGURA_CONSOLE_ORIGINS: invalid origin ${o}`);
  }
  const orqeaUrl = env.FIGURA_ORQEA_URL ?? 'https://orqea.dev';
  if (!/^https?:\/\/[^\s]+$/i.test(orqeaUrl))
    throw new Error('FIGURA_ORQEA_URL must be an http(s) URL');
  return {
    databaseUrl,
    sessionSecret,
    ssoSecret,
    appId: env.FIGURA_APP_ID ?? 'figura',
    consoleOrigins: origins,
    loopbackOnly: env.FIGURA_LOOPBACK_ONLY !== 'false',
    crossSiteCookie: env.FIGURA_COOKIE_CROSS_SITE === 'true',
    sessionTtlMinutes: Number(env.FIGURA_SESSION_TTL_MIN ?? 120),
    port: Number(env.FIGURA_PORT ?? 4000),
    host: env.FIGURA_HOST ?? '127.0.0.1',
    screenshotsDir: env.FIGURA_SCREENSHOTS_DIR ?? 'data/screenshots',
    uiDir: env.FIGURA_UI_DIR ?? defaults.uiDir,
    maxRunsListed: 200,
    targets: parseTargets(env.FIGURA_TARGETS),
    vigieSecret,
    orqeaUrl,
  };
}
