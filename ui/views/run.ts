import type { I18nKey } from '../../shared/i18n.js';
import type { Ctx } from '../context.js';
import { h, table } from '../dom.js';
import type { PublicRun, UiEvent } from '../types.js';
import { targetLabel } from './runs.js';
import { exploreSection } from './explore.js';

const REPORTS = ['funnel', 'load', 'pricing', 'calibration'] as const;
const FINAL = ['done', 'failed', 'refused', 'cancelled'];

export function inspector(ctx: Ctx, runId: string, events: UiEvent[]): HTMLElement {
  const { doc, t } = ctx;
  const steps = events.filter((e) => e.kind === 'step');
  if (steps.length === 0) return h(doc, 'p', {}, t('inspector.none'));
  return table(
    doc,
    [
      t('inspector.time'),
      t('inspector.useCase'),
      t('inspector.attempt'),
      t('inspector.facts'),
      t('inspector.friction'),
      t('inspector.frustration'),
      t('inspector.decision'),
      t('inspector.rule'),
      t('inspector.screenshot'),
    ],
    steps.map((e) => [
      e.simTime.slice(0, 16).replace('T', ' '),
      e.useCaseId ?? '',
      String(e.attempt),
      e.facts
        ? Object.entries(e.facts)
            .filter(([, v]) => v !== 0 && v !== false)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : '',
      e.friction ? `${e.friction.score} (${e.friction.reasons.map((r) => r.code).join(', ')})` : '',
      String(e.frustration),
      e.action ?? '',
      e.rule,
      e.screenshot
        ? h(
            doc,
            'a',
            {
              href: `/api/runs/${runId}/screenshots/${e.screenshot}`,
              target: '_blank',
              rel: 'noopener',
            },
            h(doc, 'img', {
              src: `/api/runs/${runId}/screenshots/${e.screenshot}`,
              alt: `${e.personaId} · ${e.useCaseId}`,
              width: '160',
            }),
          )
        : '',
    ]),
  );
}

function reportLinks(ctx: Ctx, id: string): HTMLElement {
  const { doc, t } = ctx;
  return h(
    doc,
    'ul',
    {},
    ...REPORTS.map((k) =>
      h(
        doc,
        'li',
        {},
        `${k}: `,
        h(
          doc,
          'a',
          { href: `/api/runs/${id}/reports/${k}.html?lang=${ctx.locale}` },
          t('run.downloadHtml'),
        ),
        ' · ',
        h(doc, 'a', { href: `/api/runs/${id}/reports/${k}.json` }, t('run.downloadJson')),
      ),
    ),
  );
}

function calibration(ctx: Ctx, id: string): HTMLElement {
  const { doc, t } = ctx;
  const text = h(doc, 'textarea', {
    name: 'aggregates',
    rows: '4',
    'aria-label': t('run.calibrate'),
  }) as HTMLTextAreaElement;
  const out = h(doc, 'p', { role: 'status' });
  const form = h(
    doc,
    'form',
    {},
    h(doc, 'label', {}, t('run.calibrate'), text),
    h(doc, 'button', { type: 'submit' }, t('run.calibrateSubmit')),
    out,
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await ctx.api.post(`/api/runs/${id}/calibration`, { text: text.value });
      out.replaceChildren(
        h(
          doc,
          'a',
          { href: `/api/runs/${id}/reports/calibration.html?lang=${ctx.locale}` },
          t('run.downloadHtml'),
        ),
      );
    } catch (e) {
      out.textContent = t('app.error', { detail: (e as Error).message });
    }
  });
  return form;
}

export async function runView(ctx: Ctx, id: string): Promise<HTMLElement> {
  const { doc, t } = ctx;
  const { run, transitions } = await ctx.api.get<{
    run: PublicRun;
    transitions: {
      from_status: string | null;
      to_status: string;
      actor: string;
      at: string;
      note: string | null;
    }[];
  }>(`/api/runs/${id}`);
  const explore = run.kind === 'explore' ? await exploreSection(ctx, run) : null;
  const personaSelect = h(doc, 'select', {
    'aria-label': t('inspector.persona'),
  }) as HTMLSelectElement;
  const inspect = h(doc, 'div', {});
  const { events } = await ctx.api.get<{ events: UiEvent[] }>(`/api/runs/${id}/events`);
  const personas = [...new Set(events.map((e) => e.personaId))];
  personas.forEach((p) => personaSelect.append(h(doc, 'option', { value: p }, p)));
  const show = () =>
    inspect.replaceChildren(
      inspector(
        ctx,
        id,
        events.filter((e) => e.personaId === personaSelect.value),
      ),
    );
  personaSelect.addEventListener('change', show);
  show();
  const action = (key: I18nKey, fn: () => Promise<void>) =>
    h(doc, 'button', { type: 'button', onclick: () => void fn() }, t(key));
  const actions = FINAL.includes(run.status)
    ? action('run.delete', async () => {
        await ctx.api.del(`/api/runs/${id}`);
        ctx.go('/runs');
      })
    : action('run.cancel', async () => {
        await ctx.api.post(`/api/runs/${id}/cancel`);
        ctx.go(`/runs/${id}`);
      });
  return h(
    doc,
    'section',
    {},
    h(doc, 'h1', {}, t('run.title', { id })),
    h(
      doc,
      'p',
      {},
      `${t(`status.${run.status}` as I18nKey)} · ${t('report.seed')} ${run.seed} · ${targetLabel(run)}`,
    ),
    run.refusalCode
      ? h(
          doc,
          'p',
          { role: 'alert' },
          `${t('run.refused', { code: run.refusalCode })} — ${run.refusalMessage}`,
        )
      : null,
    run.error ? h(doc, 'p', { role: 'alert' }, `${t('run.error')}: ${run.error}`) : null,
    actions,
    explore,
    h(doc, 'h2', {}, t('run.transitions')),
    table(
      doc,
      ['', '→', '', ''],
      transitions.map((x) => [x.from_status ?? '∅', x.to_status, x.actor, x.note ?? '']),
    ),
    h(doc, 'h2', {}, t('run.reports')),
    reportLinks(ctx, id),
    calibration(ctx, id),
    h(doc, 'h2', {}, t('run.inspector')),
    personaSelect,
    inspect,
  );
}
