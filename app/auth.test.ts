import { afterEach, describe, expect, it } from 'vitest';
import { mintSsoToken, signJwt } from '../shared/jwt.js';
import { makeApp, SSO } from './test-helpers/app.js';
import { verifySsoToken } from './sso.js';

let h: Awaited<ReturnType<typeof makeApp>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const now = () => Math.floor(Date.now() / 1000);

describe('SSO from the admin console', () => {
  it('a valid token opens a short httpOnly SameSite=Strict session; the token is single use', async () => {
    h = await makeApp();
    const token = mintSsoToken(SSO, 'figura', 'Ops Alice', now());
    const r = await h!.req('POST', '/auth/sso', { body: { token } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ operator: 'Ops Alice', target: null });
    const c = r.cookies.find((x) => x.name === 'figura_session')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 3600 });
    expect(c.secure).toBeUndefined();
    const me = await h!.req('GET', '/api/me', { cookie: `figura_session=${c.value}` });
    expect(me.json).toEqual({
      operator: 'Ops Alice',
      target: null,
      targetConfigured: null,
      targets: [],
    });
    expect((await h!.req('POST', '/auth/sso', { body: { token } })).json).toEqual({
      error: 'REUSED',
    });
  });

  it('refuses expired, wrong aud/iss, bad signature, long-lived and operator-less tokens', async () => {
    h = await makeApp();
    const t = now();
    const cases: [string, string][] = [
      [mintSsoToken(SSO, 'figura', 'x', t - 120), 'EXPIRED'],
      [mintSsoToken(SSO, 'other-app', 'x', t), 'BAD_AUDIENCE'],
      [signJwt({ iss: 'someone', aud: 'figura', exp: t + 60, operator: 'x' }, SSO), 'BAD_ISSUER'],
      [mintSsoToken('w'.repeat(40), 'figura', 'x', t), 'BAD_SIGNATURE'],
      [
        signJwt({ iss: 'orqea-admin-console', aud: 'figura', exp: t + 3600, operator: 'x' }, SSO),
        'BAD_LIFETIME',
      ],
      [
        signJwt(
          {
            iss: 'orqea-admin-console',
            aud: ['a', 'figura'],
            iat: t - 100,
            exp: t + 30,
            operator: 'x',
          },
          SSO,
        ),
        'BAD_LIFETIME',
      ],
      [signJwt({ iss: 'orqea-admin-console', aud: 'figura', exp: t + 30 }, SSO), 'NO_OPERATOR'],
      [
        signJwt({ iss: 'orqea-admin-console', aud: 'figura', exp: 'soon', operator: 'x' }, SSO),
        'EXPIRED',
      ],
      ['garbage', 'MALFORMED'],
      [mintSsoToken(SSO, 'figura', 'x', t, 'Recette!'), 'BAD_TARGET'],
      [
        signJwt(
          { iss: 'orqea-admin-console', aud: 'figura', exp: t + 30, operator: 'x', target: 7 },
          SSO,
        ),
        'BAD_TARGET',
      ],
    ];
    for (const [token, error] of cases) {
      const r = await h!.req('POST', '/auth/sso', { body: { token } });
      expect(r.status, error).toBe(401);
      expect(r.json.error).toBe(error);
    }
    expect((await h!.req('POST', '/auth/sso', { body: {} })).status).toBe(400);
    expect((await h!.req('POST', '/auth/sso')).status).toBe(400);
    expect((await h!.req('POST', '/auth/sso', { body: { token: 'x'.repeat(5000) } })).status).toBe(
      400,
    );
  });

  it('accepts an audience array and trims the operator name to 120 chars', () => {
    const t = now();
    const r = verifySsoToken(
      signJwt(
        {
          iss: 'orqea-admin-console',
          aud: ['figura'],
          iat: t,
          exp: t + 60,
          operator: 'o'.repeat(300),
        },
        SSO,
      ),
      { secret: SSO, appId: 'figura', nowS: t },
    );
    expect(r).toEqual({ operator: 'o'.repeat(120), exp: t + 60, target: null });
  });

  it('keeps the signed target claim in the session; /api/me says whether it is configured', async () => {
    h = await makeApp({
      targets: {
        local: { api: 'http://backend:5001', web: 'http://frontend:3001', rewrite: {} },
        recette: { api: 'http://host.docker.internal:5102', rewrite: {} },
      },
    });
    const me = async (target: string) => {
      const token = mintSsoToken(SSO, 'figura', 'Ops', now(), target);
      const r = await h!.req('POST', '/auth/sso', { body: { token } });
      expect(r.json).toEqual({ operator: 'Ops', target });
      const c = r.cookies.find((x) => x.name === 'figura_session')!;
      return (await h!.req('GET', '/api/me', { cookie: `figura_session=${c.value}` })).json;
    };
    expect(await me('recette')).toEqual({
      operator: 'Ops',
      target: 'recette',
      targetConfigured: true,
      targets: [
        { name: 'local', api: 'http://backend:5001', web: 'http://frontend:3001' },
        { name: 'recette', api: 'http://host.docker.internal:5102', web: null },
      ],
    });
    expect((await me('qa')).targetConfigured).toBe(false);
  });

  it('cross-site console: SameSite=None; Secure', async () => {
    h = await makeApp({ crossSiteCookie: true });
    const r = await h!.req('POST', '/auth/sso', {
      body: { token: mintSsoToken(SSO, 'figura', 'x', now()) },
    });
    expect(r.cookies[0]).toMatchObject({ sameSite: 'None', secure: true });
  });

  it('without a session every API route answers 401; logout ends the session', async () => {
    h = await makeApp();
    expect((await h!.req('GET', '/api/runs')).status).toBe(401);
    expect((await h!.req('GET', '/api/runs', { cookie: 'figura_session=forged' })).status).toBe(
      401,
    );
    const cookie = await h!.login();
    expect((await h!.req('POST', '/auth/logout', { cookie })).json).toEqual({ ok: true });
    expect((await h!.req('GET', '/api/me', { cookie })).status).toBe(401);
    expect((await h!.req('POST', '/auth/logout')).json).toEqual({ ok: true });
  });

  it('state-changing API calls need the anti-CSRF header', async () => {
    h = await makeApp();
    const cookie = await h!.login();
    const r = await h!.req('POST', '/api/runs', { cookie, body: { config: {} } });
    expect(r.status).toBe(403);
  });
});

describe('loopback lock and headers', () => {
  it('a non-local Host gets 404, not 403, even on open routes', async () => {
    h = await makeApp();
    for (const url of ['/health', '/auth/sso', '/api/runs', '/']) {
      const r = await h!.app.inject({
        method: 'GET',
        url,
        headers: { host: 'figura.example.com' },
      });
      expect(r.statusCode, url).toBe(404);
    }
    const health = await h!.app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:4000' },
    });
    expect(health.statusCode).toBe(200);
    // The link of « Back to Orqea » is public: the UI learns it here.
    expect(health.json()).toEqual({ ok: true, orqeaUrl: 'https://orqea.dev' });
  });

  it('can be unlocked behind an authenticating reverse proxy', async () => {
    h = await makeApp({ loopbackOnly: false });
    expect(
      (await h!.app.inject({ method: 'GET', url: '/health', headers: { host: 'figura.internal' } }))
        .statusCode,
    ).toBe(200);
  });

  it('sends frame-ancestors (never X-Frame-Options: DENY), strict CSP, no CORS', async () => {
    h = await makeApp({ consoleOrigins: ['http://localhost:4100', 'https://admin.orqea.test'] });
    const r = await h!.req('GET', '/health', { headers: { origin: 'https://evil.test' } });
    expect(r.headers['content-security-policy']).toContain(
      'frame-ancestors http://localhost:4100 https://admin.orqea.test',
    );
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await h!.req('GET', '/api/runs')).headers['cache-control']).toBe('no-store');
    expect(r.headers['cache-control']).toBeUndefined();
  });
});
