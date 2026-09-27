import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintSsoToken } from '../../shared/jwt.js';
import { repoRoot } from '../../shared/paths.js';
import { loadSimData } from '../../worker/data.js';
import type { AppConfig } from '../config.js';
import { buildApp } from '../server.js';
import { TEST_DB_URL, testDb } from './db.js';

export const SSO = 'console-sso-secret-'.padEnd(40, 'z');
export const data = loadSimData(repoRoot());

export async function makeApp(
  overrides: Partial<AppConfig> = {},
  nowS = () => Math.floor(Date.now() / 1000),
) {
  const db = await testDb();
  const cfg: AppConfig = {
    databaseUrl: TEST_DB_URL,
    sessionSecret: 'session-secret-'.padEnd(40, 'q'),
    ssoSecret: SSO,
    appId: 'figura',
    consoleOrigins: ['http://localhost:4100'],
    loopbackOnly: true,
    crossSiteCookie: false,
    sessionTtlMinutes: 60,
    port: 0,
    host: '127.0.0.1',
    screenshotsDir: mkdtempSync(join(tmpdir(), 'app-shots-')),
    uiDir: join(tmpdir(), 'no-ui-here'),
    maxRunsListed: 50,
    targets: {},
    vigieSecret: null,
    orqeaUrl: 'https://orqea.dev',
    ...overrides,
  };
  const app = await buildApp(cfg, { db, data, nowS, logger: false });
  const H = { host: 'localhost:4000' };
  const req = async (
    method: string,
    url: string,
    o: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  ) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: o.body as object,
      headers: { ...H, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
    });
    let json: Record<string, unknown> = {};
    try {
      json = res.json();
    } catch {
      json = {};
    }
    return {
      status: res.statusCode,
      json,
      body: res.body,
      headers: res.headers,
      cookies: res.cookies,
    };
  };
  /** Signs in through SSO like the console would; returns the session cookie header. */
  const login = async (operator = 'Ops Alice', target?: string) => {
    const r = await req('POST', '/auth/sso', {
      body: { token: mintSsoToken(SSO, 'figura', operator, nowS(), target) },
    });
    const c = r.cookies.find((x) => x.name === 'figura_session')!;
    return `figura_session=${c.value}`;
  };
  const api = async (method: string, url: string, cookie: string, body?: unknown) =>
    req(method, url, { cookie, body, headers: { 'x-figura': '1' } });
  return {
    app,
    db,
    cfg,
    req,
    login,
    api,
    close: async () => {
      await app.close();
      await db.end();
    },
  };
}
