import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { mkdtempSync, existsSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCommonUi } from '../../shared/common-ui.js';
import { catalogue, paths, persona } from '../../shared/test-helpers/fixtures.js';
import type { Persona } from '../../shared/persona-schema.js';
import type { UseCase } from '../../shared/catalogue-schema.js';
import { liveFake } from '../test-helpers/live-fake.js';
import { launchBrowser } from './browser.js';
import { BrowserDriver, routeRequest } from './browser-driver.js';
import type { AttemptContext, Mistake } from '../engine/types.js';

const uc = (id: string) => catalogue.useCases.find((u) => u.id === id)!;
const commonUi = loadCommonUi(paths.ui);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE);
});
afterAll(async () => browser.close());

type Fake = Awaited<ReturnType<typeof liveFake>>;
async function session(p: Persona, fake: Fake, shots: string | null = null) {
  return BrowserDriver.open(browser, p, {
    baseUrl: fake.baseUrl,
    apiOrigin: fake.baseUrl,
    rewrite: {},
    runHeader: () => fake.runHeader(),
    screenshotDir: shots,
    stepTimeoutMs: 2500,
    commonUi,
  });
}
function ctx(
  p: Persona,
  vars: Record<string, string>,
  mistakes: Mistake[] = [],
  label = 'step',
): AttemptContext {
  return { persona: p, vars: { locale: p.locale, ...vars }, mistakes, label };
}
/** Orqea's verification link: the WEB page `/verify-email?token=`. */
const verifyUrl = (fake: Fake, email: string) =>
  `${fake.baseUrl}/verify-email?token=${fake.deps.store.userByEmail(email)!.verifyToken}`;
async function verified(fake: Fake, d: BrowserDriver, p: Persona, vars: Record<string, string>) {
  await d.attempt(uc('signup'), ctx(p, vars));
  vars.verifyUrl = verifyUrl(fake, vars.email!);
  expect((await d.attempt(uc('verify-email'), ctx(p, vars))).ok).toBe(true);
  expect((await d.attempt(uc('login'), ctx(p, vars))).ok).toBe(true);
}
const account = (id: string) => ({
  email: `synth+r1-${id}@synthetic.invalid`,
  username: `sr1_${id}`,
  password: 'Str0ngPassword1!',
});

describe('BrowserDriver against the fake Orqea', () => {
  it('a French mobile persona lives landing → first card; facts are measured', async () => {
    const fake = await liveFake();
    const shots = mkdtempSync(join(tmpdir(), 'shots-'));
    const p = persona('retired-volunteer');
    const d = await session(p, fake, shots);
    const vars = { ...account('retired-volunteer'), boardName: 'Banque', cardTitle: 'Planning' };
    const landing = await d.attempt(uc('landing'), ctx(p, vars, [], 'landing'));
    expect(landing.ok).toBe(true);
    expect(landing.facts.cookieBanner).toBe(true);
    expect(landing.facts.clicksToGoal).toBe(1); // cookie rejection
    expect(landing.pages).toEqual(['/']);
    expect(existsSync(join(shots, landing.screenshot!))).toBe(true);
    const signup = await d.attempt(uc('signup'), ctx(p, vars));
    expect(signup.ok, signup.error ?? '').toBe(true);
    expect(signup.facts).toMatchObject({ termsCheckbox: true, validationErrors: 0 });
    expect(signup.apiCalls.find((c) => c.path === '/api/auth/register')?.status).toBe(201);
    expect(fake.deps.store.userByEmail(vars.email)!.language).toBe('fr');
    const verify = await d.attempt(
      uc('verify-email'),
      ctx(p, { ...vars, verifyUrl: verifyUrl(fake, vars.email) }),
    );
    expect(verify.ok).toBe(true);
    expect(verify.pages).toEqual(['/verify-email']);
    expect((await d.attempt(uc('login'), ctx(p, vars))).ok).toBe(true);
    expect((await d.attempt(uc('create-board'), ctx(p, vars))).ok).toBe(true);
    const card = await d.attempt(uc('create-card'), ctx(p, vars));
    expect(card.ok, card.error ?? '').toBe(true);
    expect(card.facts.foreignText).toBe(false);
    // Numeric ids are folded into the path template.
    expect(card.apiCalls.some((c) => c.path === '/api/cards')).toBe(true);
    await d.close();
    await fake.close();
  });

  it('mistakes: server explanations (clear, or unclear in that scenario) and the terms check', async () => {
    for (const unclear of [false, true]) {
      const fake = await liveFake({}, { unclearErrors: unclear });
      const p = persona('student');
      const d = await session(p, fake);
      const r = await d.attempt(uc('signup'), ctx(p, account('student'), ['typoEmail']));
      expect(r.ok).toBe(false);
      expect(r.error).toContain('error shown');
      expect(r.facts.validationErrors).toBe(1);
      expect(r.facts.unclearErrors).toBe(unclear ? 1 : 0);
      const terms = await d.attempt(uc('signup'), ctx(p, account('student'), ['forgetTerms']));
      expect(terms.error).toContain('error shown: Please accept the terms');
      await d.close();
      await fake.close();
    }
  });

  it('paywall (402) is reported with its feature', async () => {
    const fake = await liveFake();
    const p = persona('project-manager');
    const d = await session(p, fake);
    await verified(fake, d, p, { ...account('project-manager') });
    const r = await d.attempt(uc('qr-create'), ctx(p, {}));
    expect(r.ok).toBe(false);
    expect(r.paywall).toEqual({ code: 'FEATURE_LOCKED', featureKey: 'qrCodes' });
    expect(r.facts.paywall).toBe(true);
    expect(r.error).toContain('paywall shown');
    await d.close();
    await fake.close();
  });

  it('every use case, with the steps real Orqea does not name failing as they would', async () => {
    const fake = await liveFake({}, { lockedFeatures: [] });
    const p = persona('agency');
    const d = await session(p, fake);
    const vars: Record<string, string> = {
      ...account('agency'),
      boardName: 'Client A',
      cardTitle: 'Brief',
      inviteEmail: 'synth+r1-guest@synthetic.invalid',
      strangerEmail: 'synth+r1-stranger@synthetic.invalid',
    };
    await verified(fake, d, p, vars);
    for (const id of [
      'onboarding',
      'create-board',
      'create-list',
      'create-card',
      'move-card',
      'checklist',
      'bulk-actions',
      'automation-rule',
      'invite-member',
      'invite-without-account',
      'calendar',
      'notes-reminder',
      'form-create',
      'qr-create',
      'global-search',
      'settings-theme',
      'data-export',
      'billing-view-plans',
    ]) {
      const r = await d.attempt(uc(id), ctx(p, vars));
      expect(r.ok, `${id}: ${r.error}`).toBe(true);
    }
    // Known facts of the real Orqea (docs/ORQEA_UI_FACTS.md), reproduced by the fake.
    const fails: [string, string][] = [
      ['edit-card', 'no textbox named "Description"'],
      ['comment', 'no textbox named "Add a comment"'],
      ['mention', 'no textbox named "Add a comment"'],
      ['settings-language', 'no combobox named "Preferred language"'],
      // No priority level exists on a new board: there is no "High" to pick.
      ['card-priority', 'selectOption: Timeout'],
    ];
    for (const [id, why] of fails) {
      const r = await d.attempt(uc(id), ctx(p, vars));
      expect([r.ok, r.error ?? ''], id).toEqual([false, expect.stringContaining(why)]);
    }
    // The public form needs its token, which only the API path captures.
    const token = [...fake.deps.store.forms.values()][0]!.token;
    const answer = await d.attempt(uc('form-answer-public'), ctx(p, { ...vars, formToken: token }));
    expect(answer.ok, answer.error ?? '').toBe(true);
    const checkout = await d.attempt(
      uc('billing-checkout'),
      ctx(p, { ...vars, planName: 'Pro', planKey: 'pro' }),
    );
    expect(checkout.ok, checkout.error ?? '').toBe(true);
    const del = await d.attempt(uc('account-delete'), ctx(p, vars));
    expect(del.ok, del.error ?? '').toBe(true);
    expect(fake.deps.store.userByEmail(vars.email!)).toBeUndefined();
    await d.close();
    await fake.close();
  });

  it('screen-reader persona: keyboard only, blocked by unnamed controls and by drag and drop', async () => {
    const fake = await liveFake({}, { unnamedControls: true });
    const p = persona('screen-reader-user');
    const d = await session(p, fake);
    const vars = { ...account('screen-reader-user'), boardName: 'Mine', cardTitle: 'Read mail' };
    await verified(fake, d, p, vars);
    expect((await d.attempt(uc('create-board'), ctx(p, vars))).ok).toBe(true);
    const card = await d.attempt(uc('create-card'), ctx(p, vars));
    expect(card.ok).toBe(false);
    expect(card.facts.targetUnnamed).toBe(true);
    expect(card.facts.unnamedControls).toBeGreaterThan(0);
    const drag: UseCase = {
      ...uc('move-card'),
      ui: [
        { action: 'goto', path: '/dashboard' },
        {
          action: 'drag',
          target: { role: 'button', name: { en: 'Mine', fr: 'Mine' } },
          to: { role: 'button', name: { en: 'Mine', fr: 'Mine' } },
        },
      ],
    };
    const r = await d.attempt(drag, ctx(p, vars));
    expect(r.error).toContain('no keyboard alternative');
    expect(r.facts.targetUnnamed).toBe(false);
    await d.close();
    await fake.close();
  });

  it('untranslated pages: the French persona falls back to English names and notices', async () => {
    const fake = await liveFake({}, { untranslated: true });
    const p = persona('teacher');
    const d = await session(p, fake);
    const r = await d.attempt(uc('landing'), ctx(p, {}));
    expect(r.ok).toBe(true);
    expect(r.facts.foreignText).toBe(true);
    await d.close();
    await fake.close();
  });

  it('captcha-would-show header and slow pages', async () => {
    const fake = await liveFake({}, { captcha: true, slowMs: 300 });
    const p = persona('tech-lead');
    const d = await session(p, fake);
    const signup = await d.attempt(uc('signup'), ctx(p, account('tech-lead')));
    expect(signup.facts.captcha).toBe(true);
    expect(signup.facts.timeToInteractiveMs).toBeGreaterThanOrEqual(250);
    await d.close();
    await fake.close();
  });
});

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    ),
  );
}

describe('routing: rewritten origins, run header only to the API', () => {
  it('routeRequest maps public origins and flags API requests', () => {
    const o = {
      apiOrigin: 'http://backend:5001',
      rewrite: {
        'http://localhost:5001': 'http://backend:5001',
        'http://localhost:3001': 'http://frontend:3001',
      },
    };
    expect(routeRequest('http://localhost:5001/api/x?y=1', o)).toEqual({
      url: 'http://backend:5001/api/x?y=1',
      rewritten: true,
      toApi: true,
    });
    expect(routeRequest('http://localhost:3001/board/2', o)).toEqual({
      url: 'http://frontend:3001/board/2',
      rewritten: true,
      toApi: false,
    });
    expect(routeRequest('https://cdn.example/a.js', o)).toEqual({
      url: 'https://cdn.example/a.js',
      rewritten: false,
      toApi: false,
    });
    expect(routeRequest('http://backend:5001/api', o).toApi).toBe(true);
  });

  it('the page keeps its public origin; only API requests get X-Synthetic-Run', async () => {
    const seen: { who: string; path: string; headers: IncomingHttpHeaders }[] = [];
    const api = await listen((req, res) => {
      seen.push({ who: 'api', path: req.url!, headers: req.headers });
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
      });
      res.end('{}');
    });
    const other = await listen((req, res) => {
      seen.push({ who: 'other', path: req.url!, headers: req.headers });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    });
    // The "public" API origin the SPA was built with: nothing listens there.
    const publicApi = 'http://127.0.0.1:9';
    const web = await listen((req, res) => {
      seen.push({ who: 'web', path: req.url!, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html lang="en"><body><h1>App</h1><img src="${other.url}/logo.svg" alt="logo">
<script>fetch('${publicApi}/api/cards/12/comments').then(() => { document.body.insertAdjacentHTML('beforeend', '<p role="status">Pinged</p>'); });</script></body></html>`);
    });
    const p = persona('tech-lead');
    const d = await BrowserDriver.open(browser, p, {
      baseUrl: 'http://127.0.0.1:8', // the public web origin, rewritten below
      apiOrigin: api.url,
      rewrite: { [publicApi]: api.url, 'http://127.0.0.1:8': web.url },
      runHeader: () => 'r1.1.abc',
      screenshotDir: null,
      stepTimeoutMs: 3000,
      commonUi,
    });
    const r = await d.attempt(
      {
        ...uc('landing'),
        ui: [
          { action: 'goto', path: '/' },
          { action: 'expectText', text: { en: 'Pinged', fr: 'Pinged' }, role: 'status' },
        ],
      },
      ctx(p, {}),
    );
    expect(r.ok, r.error ?? '').toBe(true);
    expect(r.pages).toEqual(['/']);
    const byWho = (who: string) => seen.filter((s) => s.who === who);
    // The image is a fire-and-forget request: wait for it instead of racing the page script.
    await vi.waitFor(() => expect(byWho('other').length).toBeGreaterThan(0));
    expect(byWho('web')[0]!.headers['x-synthetic-run']).toBeUndefined();
    expect(byWho('other')[0]!.headers['x-synthetic-run']).toBeUndefined();
    expect(r.apiCalls.map((c) => c.path)).toContain('/api/cards/:id/comments');
    const ping = byWho('api').find((s) => s.path === '/api/cards/12/comments')!;
    expect(ping.headers['x-synthetic-run']).toBe('r1.1.abc');
    expect(ping.headers.origin).toBe('http://127.0.0.1:8');
    await d.close();
    for (const s of [api, other, web]) await new Promise((res) => s.server.close(res));
  });
});

describe('BrowserDriver edge cases', () => {
  it('5xx, non-JSON 402, missing controls, hidden elements, text steps and unreachable targets', async () => {
    const { server, url: baseUrl } = await listen((req, res) => {
      const html = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html lang="en"><body>${body}</body></html>`);
      };
      if (req.url === '/boom') return html(500, '<h1>Oops</h1>');
      if (req.url === '/pay') return html(402, '<h1>Pay</h1>');
      if (req.url === '/limit' || req.url === '/empty') {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(req.url === '/limit' ? '{"limitKey":"maxBoards"}' : '{}');
      }
      if (req.url === '/busy')
        return html(
          200,
          '<button type="button">Go</button><script>setInterval(() => fetch("/tick"), 100)</script>',
        );
      if (req.url === '/tick') return html(200, '');
      return html(
        200,
        '<h1>Visible</h1><h2 hidden>Ghost</h2><p>Plain words</p><p role="status">Enregistré</p>' +
          '<label>Size <select><option>S</option><option>M</option></select></label>',
      );
    });
    const p = persona('tech-lead');
    const d = await BrowserDriver.open(browser, p, {
      baseUrl,
      apiOrigin: baseUrl,
      rewrite: {},
      runHeader: () => 'r.1.x',
      screenshotDir: null,
      stepTimeoutMs: 3000,
      commonUi,
    });
    const probe = (path: string, ...rest: UseCase['ui']): UseCase => ({
      ...uc('landing'),
      ui: [{ action: 'goto', path }, ...rest],
    });
    expect((await d.attempt(probe('/boom'), ctx(p, {}))).facts.networkErrors).toBe(1);
    expect((await d.attempt(probe('/pay'), ctx(p, {}))).paywall).toEqual({
      code: 'PAYWALL',
      featureKey: 'unknown',
    });
    expect((await d.attempt(probe('/limit'), ctx(p, {}))).paywall).toEqual({
      code: 'PAYWALL',
      featureKey: 'maxBoards',
    });
    expect((await d.attempt(probe('/empty'), ctx(p, {}))).paywall).toEqual({
      code: 'PAYWALL',
      featureKey: 'unknown',
    });
    const heading = (name: string) => ({
      action: 'expect' as const,
      target: { role: 'heading', name: { en: name, fr: name } },
    });
    expect((await d.attempt(probe('/', heading('Visible')), ctx(p, {}))).ok).toBe(true);
    // A same-document navigation has no HTTP response.
    const hash = await d.attempt(probe('/#top'), ctx(p, {}));
    expect(hash.navigationStatus).toBeNull();
    const ghost = await d.attempt(probe('/', heading('Ghost')), ctx(p, {}));
    expect(ghost.error).toBe('step 2: no heading named "Ghost"');
    expect(ghost.facts.targetUnnamed).toBe(false);
    const text = (en: string, fr: string, role?: string) => ({
      action: 'expectText' as const,
      text: { en, fr },
      ...(role ? { role } : {}),
    });
    const pressed = await d.attempt(
      probe('/', { action: 'press', key: 'Tab' }, text('Plain words', 'Mots')),
      ctx(p, {}),
    );
    expect([pressed.ok, pressed.facts.clicksToGoal]).toEqual([true, 1]);
    const size = { role: 'combobox', name: { en: 'Size', fr: 'Taille' } };
    const picked = await d.attempt(
      probe('/', { action: 'select', target: size, value: 'M' }),
      ctx(p, {}),
    );
    expect(picked.ok, picked.error ?? '').toBe(true);
    // English persona, French page: found through the other language, noticed as foreign.
    const fr = await d.attempt(probe('/', text('Saved', 'Enregistré', 'status')), ctx(p, {}));
    expect([fr.ok, fr.facts.foreignText]).toEqual([true, true]);
    const none = await d.attempt(probe('/', text('Nowhere', 'Nulle part')), ctx(p, {}));
    expect(none.error).toBe('step 2: no "Nowhere"');
    // Ending on a click: the driver waits for the network to settle, and gives up on a busy page.
    const go = { role: 'button', name: { en: 'Go', fr: 'Go' } };
    const busy = await d.attempt(probe('/busy', { action: 'click', target: go }), ctx(p, {}));
    expect(busy.ok).toBe(true);
    expect(busy.wallMs).toBeGreaterThanOrEqual(900);
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    const down = await d.attempt(probe('/'), ctx(p, {}));
    expect(down.ok).toBe(false);
    expect(down.facts.networkErrors).toBeGreaterThan(0);
    expect(down.unreachable).toBe(true);
    expect(down.navigationStatus).toBeNull();
    await d.close();
  });
});
