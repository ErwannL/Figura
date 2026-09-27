import { describe, expect, it } from 'vitest';
import { appConfigFromEnv } from './config.js';

const env = {
  FIGURA_SESSION_SECRET: 's'.repeat(32),
  FIGURA_SSO_SECRET: 'k'.repeat(32),
  FIGURA_DATABASE_URL: 'postgres://x',
};
describe('app config', () => {
  it('safe defaults', () => {
    expect(appConfigFromEnv(env, { uiDir: '/ui' })).toMatchObject({
      loopbackOnly: true,
      crossSiteCookie: false,
      host: '127.0.0.1',
      port: 4000,
      appId: 'figura',
      consoleOrigins: ['http://localhost:4100'],
      uiDir: '/ui',
      sessionTtlMinutes: 120,
      targets: {},
    });
  });
  it('FIGURA_VIGIE_SECRET: null when absent or short, refused when equal to another secret', () => {
    const cfg = (v?: string) =>
      appConfigFromEnv({ ...env, FIGURA_VIGIE_SECRET: v }, { uiDir: '/ui' });
    expect(cfg().vigieSecret).toBeNull();
    expect(cfg('short').vigieSecret).toBeNull();
    expect(cfg('v'.repeat(32)).vigieSecret).toBe('v'.repeat(32));
    expect(() => cfg(env.FIGURA_SSO_SECRET)).toThrow('FIGURA_VIGIE_SECRET must differ');
    expect(() => cfg(env.FIGURA_SESSION_SECRET)).toThrow('FIGURA_VIGIE_SECRET must differ');
  });
  it('FIGURA_ORQEA_URL: orqea.dev by default, any http(s) URL, anything else refused', () => {
    const cfg = (v?: string) => appConfigFromEnv({ ...env, FIGURA_ORQEA_URL: v }, { uiDir: '/ui' });
    expect(cfg().orqeaUrl).toBe('https://orqea.dev');
    expect(cfg('http://localhost:3001/apps/return').orqeaUrl).toBe(
      'http://localhost:3001/apps/return',
    );
    expect(() => cfg('javascript:alert(1)')).toThrow('FIGURA_ORQEA_URL');
  });
  it('reads named Orqea targets from FIGURA_TARGETS, refusing a malformed one', () => {
    const targets = '{"recette":{"api":"http://host.docker.internal:5102"}}';
    expect(appConfigFromEnv({ ...env, FIGURA_TARGETS: targets }, { uiDir: '/ui' }).targets).toEqual(
      {
        recette: { api: 'http://host.docker.internal:5102', rewrite: {} },
      },
    );
    expect(() => appConfigFromEnv({ ...env, FIGURA_TARGETS: '[' }, { uiDir: '/ui' })).toThrow(
      'FIGURA_TARGETS',
    );
  });
  it('overrides', () => {
    const c = appConfigFromEnv(
      {
        ...env,
        FIGURA_LOOPBACK_ONLY: 'false',
        FIGURA_COOKIE_CROSS_SITE: 'true',
        FIGURA_CONSOLE_ORIGINS: 'https://a.b, http://c:1',
        FIGURA_APP_ID: 'x',
        FIGURA_SESSION_TTL_MIN: '5',
        FIGURA_PORT: '1',
        FIGURA_HOST: '0.0.0.0',
        FIGURA_SCREENSHOTS_DIR: '/s',
        FIGURA_UI_DIR: '/u',
      },
      { uiDir: '/ui' },
    );
    expect(c).toMatchObject({
      loopbackOnly: false,
      crossSiteCookie: true,
      consoleOrigins: ['https://a.b', 'http://c:1'],
      appId: 'x',
      sessionTtlMinutes: 5,
      port: 1,
      host: '0.0.0.0',
      screenshotsDir: '/s',
      uiDir: '/u',
    });
  });
  it('rejects weak, shared or missing secrets and bad origins', () => {
    expect(() => appConfigFromEnv({ ...env, FIGURA_SSO_SECRET: 'x' }, { uiDir: '' })).toThrow(
      'FIGURA_SSO_SECRET',
    );
    expect(() =>
      appConfigFromEnv({ ...env, FIGURA_SSO_SECRET: env.FIGURA_SESSION_SECRET }, { uiDir: '' }),
    ).toThrow('must differ');
    expect(() => appConfigFromEnv({ ...env, FIGURA_DATABASE_URL: '' }, { uiDir: '' })).toThrow(
      'DATABASE_URL',
    );
    expect(() =>
      appConfigFromEnv(
        {
          FIGURA_SESSION_SECRET: env.FIGURA_SESSION_SECRET,
          FIGURA_SSO_SECRET: env.FIGURA_SSO_SECRET,
        },
        { uiDir: '' },
      ),
    ).toThrow('DATABASE_URL');
    expect(() =>
      appConfigFromEnv({ ...env, FIGURA_CONSOLE_ORIGINS: "* 'unsafe'" }, { uiDir: '' }),
    ).toThrow('invalid origin');
    expect(() => appConfigFromEnv({}, { uiDir: '' })).toThrow('FIGURA_SESSION_SECRET');
  });
});
