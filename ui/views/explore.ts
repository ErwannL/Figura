import { ApiError } from '../api.js';
import type { Ctx } from '../context.js';
import { h, table } from '../dom.js';
import type { ExploreAnomaly, ExploreProgress, ExploreReport, Meta, PublicRun } from '../types.js';

/** Live progress is refreshed this often while the run is active. */
export const REFRESH_MS = 3000;
const FINAL = ['done', 'failed', 'refused', 'cancelled'];

const shotUrl = (runId: string, file: string) => `/api/runs/${runId}/screenshots/${file}`;

function field(ctx: Ctx, label: string, control: HTMLElement): HTMLElement {
  return h(ctx.doc, 'label', {}, h(ctx.doc, 'span', {}, label), control);
}

/** The explorer part of the new-run form (read only when the mode is "explore"). */
export function explorerFields(ctx: Ctx, meta: Meta): HTMLElement {
  const { doc, t } = ctx;
  const { caps, defaults, devices } = meta.explorer;
  const num = (name: string, value: number, max: number, step = '1') =>
    h(doc, 'input', {
      name,
      type: 'number',
      min: '0',
      max: String(max),
      step,
      value: String(value),
    });
  return h(
    doc,
    'fieldset',
    { 'data-explorer': '' },
    h(doc, 'legend', {}, t('form.explorer')),
    h(doc, 'p', {}, t('form.explorer.freeOnly')),
    h(
      doc,
      'fieldset',
      {},
      h(doc, 'legend', {}, t('form.explorer.devices')),
      ...devices.map((d, i) =>
        h(
          doc,
          'label',
          {},
          h(doc, 'input', { type: 'checkbox', name: 'device', value: d.key, checked: i === 0 }),
          d.label[ctx.locale],
        ),
      ),
    ),
    field(
      ctx,
      t('form.explorer.sessions', { max: caps.sessions }),
      h(
        doc,
        'select',
        { name: 'sessions' },
        ...Array.from({ length: caps.sessions }, (_, i) =>
          h(
            doc,
            'option',
            { value: String(i + 1), selected: i + 1 === defaults.sessions },
            String(i + 1),
          ),
        ),
      ),
    ),
    field(
      ctx,
      t('form.explorer.maxActions', { max: caps.maxActions }),
      num('maxActions', defaults.maxActions, caps.maxActions),
    ),
    field(
      ctx,
      t('form.explorer.maxMinutes', { max: caps.maxMinutes }),
      num('maxMinutes', defaults.maxMinutes, caps.maxMinutes),
    ),
    field(
      ctx,
      t('form.explorer.clumsiness', { max: caps.clumsiness }),
      num('clumsiness', defaults.clumsiness, caps.clumsiness, '0.01'),
    ),
    field(
      ctx,
      t('form.explorer.seedData'),
      h(doc, 'input', { type: 'checkbox', name: 'seedData' }),
    ),
  );
}

/** The explorer parameters from the form (the server enforces the caps). */
export function readExplorer(form: HTMLFormElement): Record<string, unknown> {
  const v = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
  return {
    devices: Array.from(
      form.querySelectorAll<HTMLInputElement>('input[name="device"]:checked'),
    ).map((i) => i.value),
    sessions: Number(v('sessions')),
    maxActions: Number(v('maxActions')),
    maxMinutes: Number(v('maxMinutes')),
    clumsiness: Number(v('clumsiness')),
    seedData: (form.elements.namedItem('seedData') as HTMLInputElement).checked,
  };
}

export function progressView(ctx: Ctx, runId: string, p: ExploreProgress): HTMLElement {
  const { doc, t } = ctx;
  return h(
    doc,
    'div',
    { role: 'status' },
    h(doc, 'p', {}, t('explore.progressLine', { states: p.states, anomalies: p.anomalies })),
    h(
      doc,
      'ul',
      {},
      ...p.sessions.map((s) =>
        h(
          doc,
          'li',
          {},
          t('explore.sessionProgress', {
            session: `${s.device} #${s.slot + 1}`,
            step: s.step,
            states: s.states,
          }),
        ),
      ),
    ),
    p.lastAction ? h(doc, 'p', {}, p.lastAction) : null,
    p.lastScreenshot
      ? h(doc, 'img', {
          src: shotUrl(runId, p.lastScreenshot),
          alt: t('explore.lastShot'),
          width: '320',
        })
      : null,
  );
}

/** Re-reads the run and redraws its progress until it ends or the view is left. */
export async function refreshProgress(ctx: Ctx, runId: string, box: HTMLElement): Promise<void> {
  if (!box.isConnected) return;
  try {
    const { run } = await ctx.api.get<{ run: PublicRun }>(`/api/runs/${runId}`);
    if (run.progress) box.replaceChildren(progressView(ctx, runId, run.progress));
    if (FINAL.includes(run.status)) return ctx.go(`/runs/${runId}`);
  } catch {
    // A missed refresh is retried at the next tick.
  }
  ctx.win.setTimeout(refreshProgress.bind(null, ctx, runId, box), REFRESH_MS);
}

/** Queues a replay: same seed, same device and slot, up to the anomaly's step. */
export async function replay(
  ctx: Ctx,
  run: PublicRun,
  a: ExploreAnomaly,
  alert: HTMLElement,
): Promise<void> {
  const c = run.config ?? {};
  try {
    const { run: created } = await ctx.api.post<{ run: { id: string } }>('/api/runs', {
      config: {
        kind: 'explore',
        label: `replay ${run.id} ${a.type}`,
        ...(c.target ? { target: c.target } : {}),
        targetUrl: c.targetUrl ?? run.targetUrl,
        allowRemote: c.allowRemote ?? false,
        confirmHost: c.confirmHost ?? null,
        seed: a.replay.seed,
        explorer: {
          ...(c.explorer ?? {}),
          replay: { device: a.replay.device, slot: a.replay.slot, untilStep: a.replay.untilStep },
        },
      },
    });
    ctx.go(`/runs/${created.id}`);
  } catch (e) {
    alert.textContent = ctx.t('form.invalid', {
      detail: e instanceof ApiError ? e.message : (e as Error).message,
    });
    alert.hidden = false;
  }
}

function evidence(ctx: Ctx, runId: string, a: ExploreAnomaly): HTMLElement {
  const { doc } = ctx;
  return h(
    doc,
    'div',
    {},
    h(doc, 'p', {}, a.message),
    a.excerpt && a.excerpt !== a.message ? h(doc, 'pre', {}, a.excerpt) : null,
    ...a.screenshots.map((f) =>
      h(
        doc,
        'a',
        { href: shotUrl(runId, f), target: '_blank', rel: 'noopener' },
        h(doc, 'img', { src: shotUrl(runId, f), alt: `${a.type} · ${f}`, width: '160' }),
      ),
    ),
  );
}

/** Anomalies sorted by severity, filterable by device and type, each with evidence and replay. */
export function anomaliesView(ctx: Ctx, run: PublicRun, report: ExploreReport): HTMLElement {
  const { doc, t } = ctx;
  if (report.anomalies.length === 0) return h(doc, 'p', {}, t('explore.noAnomaly'));
  const alert = h(doc, 'p', { role: 'alert', hidden: true });
  const select = (label: string, values: string[]) =>
    h(
      doc,
      'select',
      { 'aria-label': label },
      h(doc, 'option', { value: '' }, t('explore.all')),
      ...values.map((v) => h(doc, 'option', { value: v }, v)),
    ) as HTMLSelectElement;
  const device = select(t('explore.filterDevice'), [
    ...new Set(report.anomalies.flatMap((a) => a.devices)),
  ]);
  const type = select(t('explore.filterType'), [...new Set(report.anomalies.map((a) => a.type))]);
  const box = h(doc, 'div', {});
  const draw = () => {
    const rows = report.anomalies.filter(
      (a) =>
        (!device.value || a.devices.includes(device.value)) &&
        (!type.value || a.type === type.value),
    );
    box.replaceChildren(
      table(
        doc,
        ['severity', 'type', 'count', 'devices', 'where', 'action', 'evidence', 'replay'].map((k) =>
          t(`explore.col.${k}` as 'explore.col.type'),
        ),
        rows.map((a) => [
          a.severity,
          a.type,
          String(a.count),
          a.devices.join(', '),
          `${a.route} · ${a.step}`,
          a.action,
          evidence(ctx, run.id, a),
          h(
            doc,
            'button',
            { type: 'button', onclick: () => void replay(ctx, run, a, alert) },
            t('explore.replay', {
              seed: a.replay.seed,
              device: a.replay.device,
              step: a.replay.untilStep,
            }),
          ),
        ]),
      ),
    );
  };
  device.addEventListener('change', draw);
  type.addEventListener('change', draw);
  draw();
  return h(doc, 'div', {}, device, type, alert, box);
}

/** Per route, the devices side by side: the visual point of the report. */
export function galleryView(ctx: Ctx, runId: string, report: ExploreReport): HTMLElement {
  const { doc } = ctx;
  const devices = report.params.devices;
  return h(
    doc,
    'div',
    { class: 'gallery' },
    ...report.gallery.map((g) =>
      h(
        doc,
        'figure',
        {},
        h(doc, 'figcaption', {}, g.route),
        ...devices.map((d) =>
          g.shots[d]
            ? h(
                doc,
                'a',
                { href: shotUrl(runId, g.shots[d]), target: '_blank', rel: 'noopener' },
                h(doc, 'img', {
                  src: shotUrl(runId, g.shots[d]),
                  alt: `${g.route} · ${d}`,
                  width: d === 'desktop' ? '360' : '180',
                }),
              )
            : h(doc, 'span', { class: 'missing' }, `${d}: —`),
        ),
      ),
    ),
  );
}

function summaryView(ctx: Ctx, report: ExploreReport): HTMLElement[] {
  const { doc, t } = ctx;
  const p = report.params;
  const c = report.cleanup;
  return [
    h(
      doc,
      'p',
      {},
      t('explore.params', {
        devices: p.devices.join(', '),
        sessions: p.sessions,
        maxActions: p.maxActions,
        maxMinutes: p.maxMinutes,
        seedData: String(p.seedData),
      }),
    ),
    h(
      doc,
      'p',
      {},
      t('explore.duration', { seed: report.seed, s: Math.round(report.durationMs / 1000) }),
    ),
    h(doc, 'h3', {}, t('explore.sessions')),
    h(
      doc,
      'ul',
      {},
      ...report.sessions.map((s) =>
        h(
          doc,
          'li',
          {},
          t('explore.sessionLine', {
            session: `${s.device} #${s.slot + 1}`,
            account: s.account,
            steps: s.steps,
            states: s.states,
            stoppedBy: s.stoppedBy,
            error: s.error ? ` (${s.error})` : '',
          }),
        ),
      ),
    ),
    h(doc, 'h3', {}, t('explore.statesByDevice')),
    table(
      doc,
      [t('explore.filterDevice'), t('explore.statesByDevice')],
      Object.entries(report.statesByDevice).map(([d, n]) => [d, String(n)]),
    ),
    h(doc, 'h3', {}, t('explore.routes')),
    table(
      doc,
      [t('explore.col.where'), t('explore.col.devices'), t('explore.col.count')],
      report.routes.map((r) => [r.route, r.devices.join(', '), String(r.visits)]),
    ),
    h(doc, 'h3', {}, t('explore.cleanup')),
    h(
      doc,
      'p',
      c && c.residualRows > 0 ? { role: 'alert' } : {},
      c
        ? t('explore.cleanupLine', {
            before: JSON.stringify(c.before),
            after: JSON.stringify(c.after),
            residual: c.residualRows,
          })
        : t('explore.cleanupPending'),
    ),
  ];
}

/** The explorer part of a run's page: live progress, then the visual report. */
export async function exploreSection(ctx: Ctx, run: PublicRun): Promise<HTMLElement> {
  const { doc, t } = ctx;
  const section = h(doc, 'section', {}, h(doc, 'h2', {}, t('explore.summary')));
  if (!FINAL.includes(run.status)) {
    const box = h(doc, 'div', {});
    if (run.progress) box.append(progressView(ctx, run.id, run.progress));
    section.append(h(doc, 'h3', {}, t('explore.progress')), box);
    ctx.win.setTimeout(refreshProgress.bind(null, ctx, run.id, box), REFRESH_MS);
  }
  const report = await ctx.api
    .get<ExploreReport>(`/api/runs/${run.id}/reports/explore.json`)
    .catch(() => null);
  if (!report) {
    section.append(h(doc, 'p', {}, t('explore.noReport')));
    return section;
  }
  section.append(
    h(
      doc,
      'p',
      {},
      h(doc, 'a', { href: `/api/runs/${run.id}/reports/explore.json` }, t('explore.export')),
    ),
    ...summaryView(ctx, report),
    h(doc, 'h3', {}, t('explore.anomalies')),
    anomaliesView(ctx, run, report),
    h(doc, 'h3', {}, t('explore.gallery')),
    galleryView(ctx, run.id, report),
    h(doc, 'h3', {}, t('explore.info')),
    table(
      doc,
      [
        t('explore.col.type'),
        t('explore.col.where'),
        t('explore.col.action'),
        t('explore.col.count'),
      ],
      report.info.map((i) => [i.type, i.route, i.message, String(i.count)]),
    ),
  );
  return section;
}
