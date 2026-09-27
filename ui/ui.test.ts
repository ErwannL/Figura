import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { apiClient, ApiError } from './api.js';
import { boot, initialLocale, route } from './app.js';
import { makeT, type Ctx } from './context.js';
import { h, table } from './dom.js';
import { bootstrapSession } from './sso.js';
import { readForm } from './views/new-run.js';
import { inspector } from './views/run.js';

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;

const run = {
  id: 'abc123',
  kind: 'journey',
  status: 'refused',
  label: 'L',
  seed: 7,
  targetUrl: 'http://fake',
  refusalCode: 'PRODUCTION_ENV',
  refusalMessage: 'The target reports a production environment.',
  error: 'boom',
  createdAt: '2030-01-01T00:00:00Z',
};
const meta = {
  personas: [
    { id: 'student', displayName: 'Sam', locale: 'en', device: 'mobile', goal: 'g', weight: 0.5 },
  ],
  catalogue: { version: 'c1', useCases: [] },
  weightsVersion: 'w1',
  scenarios: ['baseline'],
  explorer: {
    devices: [
      { key: 'desktop', label: { en: 'Desktop', fr: 'Ordinateur' } },
      { key: 'mobile', label: { en: 'Mobile', fr: 'Mobile' } },
    ],
    caps: { sessions: 3, maxActions: 500, maxMinutes: 30, clumsiness: 0.2 },
    defaults: { sessions: 1, maxActions: 150, maxMinutes: 10, clumsiness: 0.05 },
  },
};
const event = {
  kind: 'step',
  personaId: 'student',
  simTime: '2030-01-07T09:00:00Z',
  useCaseId: 'signup',
  attempt: 1,
  friction: { score: 0.4, reasons: [{ code: 'too-many-fields', value: 0.4 }] },
  frustration: 0.4,
  action: 'abandon',
  rule: 'frustration ≥ tolerance',
  facts: { visibleFields: 6, captcha: false, clicksToGoal: 0 },
  screenshot: 's.jpg',
};

function env(hash: string, handler: Handler, lang = 'en-GB') {
  const win = new Window({ url: `http://localhost:4000/${hash}` });
  Object.defineProperty(win.navigator, 'language', { value: lang, configurable: true });
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = '<div id="app"></div>';
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = handler(url, init) ?? defaults(url);
    return new Response(r.body === undefined ? 'not json' : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  });
  return { win, doc, calls, fetchImpl, w: win as unknown as globalThis.Window };
}
function defaults(url: string): { status?: number; body?: unknown } {
  if (url === '/api/me')
    return { body: { operator: 'Ops Alice', target: null, targetConfigured: null, targets: [] } };
  if (url === '/api/runs') return { body: { runs: [run] } };
  if (url === '/api/meta') return { body: meta };
  if (url.startsWith('/api/runs/abc123/events'))
    return {
      body: {
        events: [
          event,
          { ...event, kind: 'session' },
          {
            ...event,
            personaId: 'teacher',
            friction: null,
            facts: null,
            screenshot: null,
            action: null,
            useCaseId: null,
          },
        ],
      },
    };
  if (url === '/api/runs/abc123')
    return {
      body: {
        run,
        transitions: [
          { from_status: null, to_status: 'draft', actor: 'ops', at: 'x', note: null },
          { from_status: 'draft', to_status: 'queued', actor: 'ops', at: 'x', note: 'n' },
        ],
      },
    };
  return { status: 404, body: { error: 'NOT_FOUND' } };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
function ctxFor(e: ReturnType<typeof env>, locale: 'en' | 'fr' = 'en'): Ctx {
  return {
    doc: e.doc,
    win: e.w,
    api: apiClient(e.fetchImpl),
    locale,
    t: makeT(locale),
    go: (r) => (e.win.location.hash = `#${r}`),
  };
}

describe('SSO bootstrap', () => {
  it('trades #sso= for a session, then removes the fragment', async () => {
    const e = env('#sso=a.b.c', (url, init) =>
      url === '/auth/sso' ? { body: { operator: 'Ops', echo: init.body } } : undefined,
    );
    expect(await bootstrapSession(e.w, apiClient(e.fetchImpl))).toBe('Ops');
    expect(e.win.location.hash).toBe('');
    expect(JSON.parse(e.calls[0]!.init.body as string)).toEqual({ token: 'a.b.c' });
    expect((e.calls[0]!.init.headers as Record<string, string>)['x-figura']).toBe('1');
  });
  it('a refused token or no fragment without a session gives null', async () => {
    const bad = env('#sso=x', (url) =>
      url === '/auth/sso' ? { status: 401, body: { error: 'EXPIRED' } } : undefined,
    );
    expect(await bootstrapSession(bad.w, apiClient(bad.fetchImpl))).toBeNull();
    const none = env('', (url) => (url === '/api/me' ? { status: 401 } : undefined));
    expect(await bootstrapSession(none.w, apiClient(none.fetchImpl))).toBeNull();
    const existing = env('', () => undefined);
    expect(await bootstrapSession(existing.w, apiClient(existing.fetchImpl))).toBe('Ops Alice');
  });
});

describe('boot', () => {
  it('without a session shows only "open me from the Orqea admin console", never a form', async () => {
    const e = env(
      '',
      (url) => (url === '/api/me' ? { status: 401, body: {} } : undefined),
      'fr-FR',
    );
    await boot(e.doc, e.w, e.fetchImpl);
    const text = e.doc.body.textContent;
    expect(text).toContain('Ouvrez-moi depuis la console d’administration Orqea.');
    expect(e.doc.querySelector('form, input')).toBeNull();
    expect(e.doc.documentElement.lang).toBe('fr');
  });

  it('renders runs, switches language (persisted), navigates by hash, shows errors', async () => {
    const e = env('', () => undefined);
    await boot(e.doc, e.w, e.fetchImpl);
    expect(e.doc.body.textContent).toContain('Signed in as Ops Alice');
    expect(e.doc.querySelector('table a')!.getAttribute('href')).toBe('#/runs/abc123');
    const select = e.doc.querySelector('header select') as HTMLSelectElement;
    select.value = 'fr';
    select.dispatchEvent(new e.win.Event('change') as unknown as Event);
    await tick();
    expect(e.win.localStorage.getItem('figura.locale')).toBe('fr');
    expect(e.doc.querySelector('h1')!.textContent).toBe('Simulations');
    select.value = 'en';
    select.dispatchEvent(new e.win.Event('change') as unknown as Event);
    await tick();
    e.win.location.hash = '#/runs/zzz';
    await tick();
    await tick();
    expect(e.doc.querySelector('[role="alert"]')!.textContent).toContain('NOT_FOUND');
    e.win.location.hash = '#/runs/abc123';
    await tick();
    await tick();
    (e.doc.querySelector('main button[type="button"]') as HTMLButtonElement).click();
    await tick();
    expect(e.win.location.hash).toBe('#/runs');
  });

  it('keeps working when storage is blocked', async () => {
    const e = env('', () => undefined);
    Object.defineProperty(e.win, 'localStorage', {
      get: () => {
        throw new Error('blocked');
      },
    });
    expect(initialLocale(e.w)).toBe('en');
    await boot(e.doc, e.w, e.fetchImpl);
    const select = e.doc.querySelector('header select') as HTMLSelectElement;
    select.value = 'fr';
    select.dispatchEvent(new e.win.Event('change') as unknown as Event);
    await tick();
    expect(e.doc.documentElement.lang).toBe('fr');
  });
});

describe('views', () => {
  it('empty runs list', async () => {
    const e = env('', (url) => (url === '/api/runs' ? { body: { runs: [] } } : undefined));
    expect((await route(ctxFor(e), '/runs')).textContent).toContain('No run yet');
  });

  it('new run: reads the form, queues, and explains validation errors', async () => {
    let status = 400;
    const e = env('', (url, init) =>
      url === '/api/runs' && init.method === 'POST'
        ? status === 400
          ? { status, body: { error: 'INVALID_CONFIG', issues: ['targetUrl: bad'] } }
          : status === 500
            ? { status }
            : { status: 201, body: { run: { id: 'n1' } } }
        : undefined,
    );
    const view = await route(ctxFor(e), '/new');
    const form = view.querySelector('form') as HTMLFormElement;
    const cfg = readForm(form);
    expect(cfg).toMatchObject({
      kind: 'journey',
      personaIds: ['student'],
      totalSimulatedDays: 7,
      confirmHost: null,
      fakeScenario: null,
    });
    expect(cfg.seed).toBeUndefined();
    expect(cfg.explorer).toBeUndefined();
    (form.elements.namedItem('kind') as HTMLSelectElement).value = 'explore';
    (form.querySelector('input[name="device"][value="mobile"]') as HTMLInputElement).checked = true;
    (form.elements.namedItem('sessions') as HTMLSelectElement).value = '3';
    (form.elements.namedItem('seedData') as HTMLInputElement).checked = true;
    expect(readForm(form).explorer).toEqual({
      devices: ['desktop', 'mobile'],
      sessions: 3,
      maxActions: 150,
      maxMinutes: 10,
      clumsiness: 0.05,
      seedData: true,
    });
    (form.elements.namedItem('kind') as HTMLSelectElement).value = 'journey';
    (form.elements.namedItem('seed') as HTMLInputElement).value = '9';
    (form.elements.namedItem('priceScenarios') as HTMLTextAreaElement).value =
      '[{"name":"x","prices":{"pro":1}}]';
    (form.elements.namedItem('confirmHost') as HTMLInputElement).value = 'h';
    expect(readForm(form)).toMatchObject({
      seed: 9,
      priceScenarios: [{ name: 'x', prices: { pro: 1 } }],
      confirmHost: 'h',
    });
    const submit = async () => {
      form.dispatchEvent(new e.win.Event('submit', { cancelable: true }) as unknown as Event);
      await tick();
    };
    await submit();
    expect(view.querySelector('[role="alert"]')!.textContent).toBe(
      'Please check the form: targetUrl: bad',
    );
    status = 500;
    await submit();
    expect(view.querySelector('[role="alert"]')!.textContent).toContain('500');
    (form.elements.namedItem('priceScenarios') as HTMLTextAreaElement).value = '{broken';
    await submit();
    expect(view.querySelector('[role="alert"]')!.textContent).toContain('JSON');
    (form.elements.namedItem('priceScenarios') as HTMLTextAreaElement).value = '';
    status = 201;
    await submit();
    expect(e.win.location.hash).toBe('#/runs/n1');
  });

  it('new run: preselects the Orqea the console inspects, or says it is not configured', async () => {
    const targets = [
      { name: 'local', api: 'http://backend:5001', web: 'http://frontend:3001' },
      { name: 'recette', api: 'http://host.docker.internal:5102', web: null },
    ];
    const me = (target: string, targetConfigured: boolean) => (url: string) =>
      url === '/api/me'
        ? { body: { operator: 'Ops', target, targetConfigured, targets } }
        : undefined;
    const view = await route(ctxFor(env('', me('recette', true))), '/new');
    const select = view.querySelector('select[name="target"]') as HTMLSelectElement;
    expect(select.value).toBe('recette');
    expect(select.options[2]!.textContent).toBe('recette — http://host.docker.internal:5102');
    expect(view.querySelector('[role="status"]')!.textContent).toContain('Testing Orqea “recette”');
    expect(readForm(view.querySelector('form') as HTMLFormElement)).toMatchObject({
      target: 'recette',
    });
    const fr = await route(ctxFor(env('', me('qa', false)), 'fr'), '/new');
    expect(fr.querySelector('[role="alert"]')!.textContent).toContain('TARGET_NOT_CONFIGURED');
    expect((fr.querySelector('select[name="target"]') as HTMLSelectElement).value).toBe('');
    expect(readForm(fr.querySelector('form') as HTMLFormElement).target).toBeUndefined();
  });

  it('runs on a named target show its name next to the URL', async () => {
    const named = { ...run, config: { target: 'recette' } };
    const e = env('', (url) =>
      url === '/api/runs'
        ? { body: { runs: [named] } }
        : url === '/api/runs/abc123'
          ? { body: { run: named, transitions: [] } }
          : undefined,
    );
    expect((await route(ctxFor(e), '/runs')).textContent).toContain('recette · http://fake');
    expect((await route(ctxFor(e), '/runs/abc123')).textContent).toContain('recette · http://fake');
  });

  it('run: refusal shown verbatim, lifecycle, reports, inspector per persona, delete', async () => {
    const e = env('', (url, init) =>
      url === '/api/runs/abc123' && init.method === 'DELETE'
        ? { body: { deleted: true } }
        : undefined,
    );
    const view = await route(ctxFor(e), '/runs/abc123');
    expect(view.textContent).toContain(
      'Refused: PRODUCTION_ENV — The target reports a production environment.',
    );
    expect(view.textContent).toContain('Error: boom');
    expect(
      view.querySelector('a[href="/api/runs/abc123/reports/funnel.html?lang=en"]'),
    ).not.toBeNull();
    expect(view.querySelector('img')!.getAttribute('src')).toBe(
      '/api/runs/abc123/screenshots/s.jpg',
    );
    expect(view.textContent).toContain('visibleFields=6');
    const select = view.querySelector('select[aria-label="Persona"]') as HTMLSelectElement;
    select.value = 'teacher';
    select.dispatchEvent(new e.win.Event('change') as unknown as Event);
    expect(view.querySelectorAll('tbody tr').length).toBe(3);
    expect(view.querySelectorAll('img')).toHaveLength(0);
    (view.querySelector('button[type="button"]') as HTMLButtonElement).click();
    await tick();
    expect(e.win.location.hash).toBe('#/runs');
  });

  it('run in progress: cancel; calibration upload success and failure', async () => {
    let calOk = true;
    const e = env('', (url, init) => {
      if (url === '/api/runs/abc123' && init.method !== 'POST')
        return {
          body: {
            run: { ...run, status: 'running', refusalCode: null, error: null },
            transitions: [],
          },
        };
      if (url.endsWith('/cancel')) return { body: {} };
      if (url.endsWith('/calibration'))
        return calOk
          ? { body: { report: {} } }
          : { status: 400, body: { error: 'INVALID_AGGREGATES' } };
      return undefined;
    });
    const view = await route(ctxFor(e, 'fr'), '/runs/abc123');
    expect(view.querySelector('[role="alert"]')).toBeNull();
    (view.querySelector('button[type="button"]') as HTMLButtonElement).click();
    await tick();
    expect(e.win.location.hash).toBe('#/runs/abc123');
    const form = view.querySelectorAll('form')[0] as HTMLFormElement;
    form.dispatchEvent(new e.win.Event('submit', { cancelable: true }) as unknown as Event);
    await tick();
    expect(form.querySelector('[role="status"] a')!.getAttribute('href')).toBe(
      '/api/runs/abc123/reports/calibration.html?lang=fr',
    );
    calOk = false;
    form.dispatchEvent(new e.win.Event('submit', { cancelable: true }) as unknown as Event);
    await tick();
    expect(form.querySelector('[role="status"]')!.textContent).toContain('INVALID_AGGREGATES');
  });

  it('compare and personas', async () => {
    const e = env('', (url) =>
      url === '/api/runs'
        ? {
            body: {
              runs: [
                { ...run, status: 'done' },
                { ...run, id: 'def456', status: 'done' },
              ],
            },
          }
        : undefined,
    );
    const view = await route(ctxFor(e), '/compare');
    const form = view.querySelector('form') as HTMLFormElement;
    (form.elements.namedItem('b') as HTMLSelectElement).value = 'def456';
    form.dispatchEvent(new e.win.Event('submit', { cancelable: true }) as unknown as Event);
    expect(view.querySelector('a')!.getAttribute('href')).toBe(
      '/api/compare?a=abc123&b=def456&lang=en&format=html',
    );
    expect((await route(ctxFor(e), '/personas')).textContent).toContain('Sam');
  });

  it('inspector with no steps; dom helpers; api errors on non-JSON', async () => {
    const e = env('', () => undefined);
    expect(inspector(ctxFor(e), 'x', []).textContent).toBe('No event for this persona.');
    const el = h(
      e.doc,
      'button',
      { disabled: true, hidden: false, onclick: () => undefined },
      'Go',
      null,
    );
    expect(el.outerHTML).toBe('<button disabled="">Go</button>');
    expect(table(e.doc, ['a'], [['1']]).querySelectorAll('td')).toHaveLength(1);
    const api = apiClient(e.fetchImpl);
    await expect(api.get('/nope-plain')).rejects.toBeInstanceOf(ApiError);
    await expect(api.del('/nope')).rejects.toThrow('NOT_FOUND');
    const noError = apiClient(async () => new Response('{}', { status: 418 }));
    await expect(noError.get('/x')).rejects.toThrow('418');
  });
});
