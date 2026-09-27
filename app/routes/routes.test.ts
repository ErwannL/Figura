import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { catalogue } from '../../shared/test-helpers/fixtures.js';
import { sampleMeta, samplePersonas, sampleRun } from '../../worker/test-helpers/sample-run.js';
import { buildFunnel } from '../../worker/reports/funnel.js';
import { saveReport } from '../db/misc.js';
import { transition } from '../db/runs.js';
import { makeApp } from '../test-helpers/app.js';

let h: Awaited<ReturnType<typeof makeApp>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const cfg = { kind: 'journey', targetUrl: 'http://localhost:4100' };

describe('runs API', () => {
  it('meta, create (validated), list, get, cancel, events, delete', async () => {
    h = await makeApp();
    const c = await h.login();
    const meta = await h.api('GET', '/api/meta', c);
    expect((meta.json.personas as unknown[]).length).toBe(10);
    expect(meta.json.scenarios).toContain('unclear-signup');
    expect((await h.api('POST', '/api/runs', c, { config: { kind: 'x' } })).status).toBe(400);
    expect(
      (await h.api('POST', '/api/runs', c, { config: { ...cfg, personaIds: ['ghost'] } })).json
        .issues,
    ).toEqual(['personaIds: unknown ghost']);
    const created = await h.api('POST', '/api/runs', c, {
      config: { ...cfg, seed: 5, label: 'first' },
    });
    expect(created.status).toBe(201);
    const run = created.json.run as { id: string; status: string; seed: number };
    expect(run).toMatchObject({ status: 'queued', seed: 5 });
    const random = await h.api('POST', '/api/runs', c, { config: cfg });
    expect(typeof (random.json.run as { seed: number }).seed).toBe('number');
    expect(((await h.api('GET', '/api/runs', c)).json.runs as unknown[]).length).toBe(2);
    const got = await h.api('GET', `/api/runs/${run.id}`, c);
    expect((got.json.transitions as unknown[]).length).toBe(2);
    expect((await h.api('GET', '/api/runs/nope', c)).status).toBe(404);
    expect((await h.api('GET', `/api/runs/${run.id}/events`, c)).json.events).toEqual([]);
    expect(
      (await h.api('GET', `/api/runs/${run.id}/events?persona=student`, c)).json.events,
    ).toEqual([]);
    expect((await h.api('DELETE', `/api/runs/${run.id}`, c)).status).toBe(409);
    expect(
      ((await h.api('POST', `/api/runs/${run.id}/cancel`, c)).json.run as { status: string })
        .status,
    ).toBe('cancelled');
    expect((await h.api('POST', '/api/runs/nope/cancel', c)).status).toBe(404);
    mkdirSync(join(h.cfg.screenshotsDir, run.id));
    expect((await h.api('DELETE', `/api/runs/${run.id}`, c)).json).toEqual({ deleted: true });
    expect(existsSync(join(h.cfg.screenshotsDir, run.id))).toBe(false);
  });
});

describe('runs on a named Orqea target (FIGURA_TARGETS)', () => {
  it('fills the URLs from the server config; unknown or web-less targets are refused', async () => {
    h = await makeApp({
      targets: {
        local: {
          api: 'http://backend:5001',
          web: 'http://frontend:3001',
          rewrite: { 'http://localhost:3001': 'http://frontend:3001' },
        },
        recette: { api: 'http://host.docker.internal:5102', rewrite: {} },
      },
    });
    const c = await h.login('Ops', 'local');
    const created = await h.api('POST', '/api/runs', c, {
      config: { kind: 'journey', target: 'local', targetUrl: 'http://evil.example' },
    });
    expect(created.status).toBe(201);
    expect((created.json.run as { config: object }).config).toMatchObject({
      target: 'local',
      targetUrl: 'http://backend:5001',
      webUrl: 'http://frontend:3001',
    });
    const unknown = await h.api('POST', '/api/runs', c, {
      config: { kind: 'journey', target: 'qa' },
    });
    expect(unknown.json).toEqual({
      error: 'TARGET_NOT_CONFIGURED',
      issues: ['target: "qa" is not configured in FIGURA_TARGETS'],
    });
    const noWeb = await h.api('POST', '/api/runs', c, {
      config: { kind: 'journey', target: 'recette' },
    });
    expect(noWeb.json.error).toBe('TARGET_NOT_CONFIGURED');
    const volume = await h.api('POST', '/api/runs', c, {
      config: { kind: 'volume', target: 'recette' },
    });
    expect((volume.json.run as { config: object }).config).toMatchObject({
      targetUrl: 'http://host.docker.internal:5102',
      webUrl: null,
    });
  });
});

describe('reports API', () => {
  async function withFunnel(id: string, h2: NonNullable<typeof h>, c: string) {
    const r = await h2.api('POST', '/api/runs', c, { config: cfg });
    const runId = (r.json.run as { id: string }).id;
    const { events, memories } = await sampleRun();
    await saveReport(
      h2.db,
      runId,
      'funnel',
      buildFunnel({ ...sampleMeta, runId }, catalogue, samplePersonas, events, memories, []),
    );
    void id;
    return runId;
  }
  it('downloads JSON and self-contained HTML with a sandboxing CSP; screenshots; compare; calibration', async () => {
    h = await makeApp();
    const c = await h.login();
    const a = await withFunnel('a', h, c);
    const b = await withFunnel('b', h, c);
    const json = await h.api('GET', `/api/runs/${a}/reports/funnel`, c);
    expect(json.json.type).toBe('funnel');
    expect(json.headers['content-disposition']).toContain(`figura-${a}-funnel.json`);
    const dir = join(h.cfg.screenshotsDir, a);
    mkdirSync(dir);
    const shot = (json.json.useCases as { abandonScreenshot: string | null }[]).find(
      (u) => u.abandonScreenshot,
    )!.abandonScreenshot!;
    writeFileSync(join(dir, shot), Buffer.from([0xff, 0xd8]));
    const html = await h.api('GET', `/api/runs/${a}/reports/funnel.html?lang=fr`, c);
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.body).toContain('data:image/jpeg;base64,');
    expect(html.body).toContain('lang="fr"');
    expect((await h.api('GET', `/api/runs/${a}/reports/funnel.pdf`, c)).status).toBe(404);
    expect((await h.api('GET', `/api/runs/${a}/reports/secrets`, c)).status).toBe(404);
    expect((await h.api('GET', `/api/runs/${a}/reports/load`, c)).status).toBe(404);
    expect(
      (await h.api('GET', `/api/runs/${a}/screenshots/${shot}`, c)).headers['content-type'],
    ).toBe('image/jpeg');
    expect((await h.api('GET', `/api/runs/${a}/screenshots/..%2Fx.jpg`, c)).status).toBe(404);
    expect((await h.api('GET', `/api/runs/BAD/screenshots/${shot}`, c)).status).toBe(404);
    const { rows } = await h.db.query('select body from reports where run_id = $1', [b]);
    rows[0].body.useCases[0].abandonScreenshot = '../../etc/passwd';
    await saveReport(h.db, b, 'funnel', rows[0].body);
    expect((await h.api('GET', `/api/runs/${b}/reports/funnel.html`, c)).body).not.toContain(
      'passwd"',
    );
    const cmp = await h.api('GET', `/api/compare?a=${a}&b=${b}`, c);
    expect(cmp.json.type).toBe('comparison');
    expect((await h.api('GET', `/api/compare?a=${a}&b=${b}&format=html`, c)).body).toContain(
      '<!doctype html>',
    );
    expect((await h.api('GET', `/api/compare?a=${a}`, c)).status).toBe(404);
    expect((await h.api('GET', '/api/compare', c)).status).toBe(404);
    const cal = await h.api('POST', `/api/runs/${a}/calibration`, c, {
      text: 'landing,1\nsignup,0.1',
    });
    expect((cal.json.report as { type: string }).type).toBe('calibration');
    expect((await h.api('GET', `/api/runs/${a}/reports/calibration`, c)).status).toBe(200);
    expect(
      (await h.api('POST', `/api/runs/${a}/calibration`, c, { text: 'landing,7' })).status,
    ).toBe(400);
    expect((await h.api('POST', `/api/runs/${a}/calibration`, c)).status).toBe(400);
    expect((await h.api('POST', '/api/runs/zzz/calibration', c, { text: 'a,1' })).status).toBe(404);
    await transition(h.db, a, 'cancelled', 'ops').catch(() => undefined);
  });
});

describe('explorer runs (API)', () => {
  const explore = { kind: 'explore', targetUrl: 'http://localhost:4100' };
  it('caps are enforced server-side; one active exploration per target (409)', async () => {
    h = await makeApp();
    const c = await h.login();
    const meta = await h.api('GET', '/api/meta', c);
    expect(meta.json.explorer).toMatchObject({
      devices: [{ key: 'desktop' }, { key: 'tablet' }, { key: 'mobile' }],
      caps: { sessions: 3, maxActions: 500, maxMinutes: 30 },
    });
    for (const bad of [{ sessions: 4 }, { maxActions: 501 }, { maxMinutes: 31 }, { devices: [] }]) {
      const r = await h.api('POST', '/api/runs', c, { config: { ...explore, explorer: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    const first = await h.api('POST', '/api/runs', c, { config: explore });
    expect(first.status).toBe(201);
    expect((first.json.run as { config: { explorer: object } }).config.explorer).toMatchObject({
      maxActions: 150,
      maxMinutes: 10,
    });
    const second = await h.api('POST', '/api/runs', c, { config: explore });
    expect(second).toMatchObject({ status: 409, json: { error: 'EXPLORATION_ACTIVE' } });
    // Another target, or another kind on the same target, is not blocked.
    expect(
      (
        await h.api('POST', '/api/runs', c, {
          config: { ...explore, targetUrl: 'http://127.0.0.1:4100' },
        })
      ).status,
    ).toBe(201);
    expect((await h.api('POST', '/api/runs', c, { config: cfg })).status).toBe(201);
    // Once the first one is over, a new exploration of that target may start.
    const id = (first.json.run as { id: string }).id;
    await h.api('POST', `/api/runs/${id}/cancel`, c);
    expect((await h.api('POST', '/api/runs', c, { config: explore })).status).toBe(201);
  });

  it('serves explorer PNG screenshots and the JSON report (no HTML export)', async () => {
    h = await makeApp();
    const c = await h.login();
    const id = (
      (await h.api('POST', '/api/runs', c, { config: explore })).json.run as { id: string }
    ).id;
    mkdirSync(join(h.cfg.screenshotsDir, id));
    writeFileSync(
      join(h.cfg.screenshotsDir, id, 'x-desktop-0-0001-state.png'),
      Buffer.from([0x89, 0x50]),
    );
    const png = await h.api('GET', `/api/runs/${id}/screenshots/x-desktop-0-0001-state.png`, c);
    expect(png.headers['content-type']).toBe('image/png');
    await saveReport(h.db, id, 'explore', { type: 'explore', runId: id });
    const json = await h.api('GET', `/api/runs/${id}/reports/explore.json`, c);
    expect(json.json).toEqual({ type: 'explore', runId: id });
    expect(json.headers['content-disposition']).toContain(`figura-${id}-explore.json`);
    expect((await h.api('GET', `/api/runs/${id}/reports/explore.html`, c)).status).toBe(404);
    const run = await h.api('GET', `/api/runs/${id}`, c);
    expect((run.json.run as { progress: unknown }).progress).toBeNull();
  });
});
