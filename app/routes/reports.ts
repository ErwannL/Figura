import type { FastifyInstance, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '../../shared/i18n.js';
import { buildCalibration, parseAggregates } from '../../worker/reports/calibration.js';
import { buildComparison } from '../../worker/reports/compare.js';
import type { FunnelReport } from '../../worker/reports/funnel.js';
import { renderReportHtml, type AnyReport } from '../../worker/reports/html.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { audit, getReport, saveCalibration, saveReport } from '../db/misc.js';
import { REPORT_CSP } from '../security.js';

const KINDS = new Set(['funnel', 'load', 'pricing', 'calibration', 'explore']);
const FILE = /^[A-Za-z0-9_-]+\.jpg$/;
/** Screenshots served to the UI: journey JPEGs and explorer PNGs. */
const SHOT = /^[A-Za-z0-9_-]+\.(jpg|png)$/;
const RUN = /^[0-9a-z]+$/;

function reportHelpers(cfg: AppConfig) {
  const image =
    (runId: string) =>
    (file: string): string | null => {
      const path = join(cfg.screenshotsDir, runId, file);
      return FILE.test(file) && existsSync(path)
        ? `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
        : null;
    };
  const send = (
    reply: FastifyReply,
    report: AnyReport,
    runId: string,
    format: string,
    lang: Locale,
    name: string,
  ) => {
    if (format === 'html') {
      return reply
        .header('content-security-policy', REPORT_CSP)
        .header('content-disposition', `attachment; filename="figura-${name}.html"`)
        .type('text/html')
        .send(renderReportHtml(report, lang, image(runId)));
    }
    return reply
      .header('content-disposition', `attachment; filename="figura-${name}.json"`)
      .send(report);
  };
  const langOf = (q: unknown): Locale => ((q as { lang?: string }).lang === 'fr' ? 'fr' : 'en');

  return { send, langOf };
}
type H = ReturnType<typeof reportHelpers>;

export function reportRoutes(app: FastifyInstance, cfg: AppConfig, db: Db): void {
  const h = reportHelpers(cfg);
  reportRoutes1(app, cfg, db, h);
}

function reportRoutes1(app: FastifyInstance, cfg: AppConfig, db: Db, h: H): void {
  const { send, langOf } = h;
  app.get('/api/runs/:id/reports/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const [name, format = 'json'] = kind.split('.') as [string, string | undefined];
    // The explorer report is JSON (the UI renders it); there is no HTML export of it.
    if (
      !KINDS.has(name) ||
      !['json', 'html'].includes(format) ||
      (name === 'explore' && format === 'html')
    )
      return reply.code(404).send({ error: 'NOT_FOUND' });
    const report = await getReport<AnyReport>(db, id, name);
    if (!report) return reply.code(404).send({ error: 'NOT_FOUND' });
    return send(reply, report, id, format, langOf(req.query), `${id}-${name}`);
  });

  app.get('/api/runs/:id/screenshots/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const path = join(cfg.screenshotsDir, id, file);
    if (!RUN.test(id) || !SHOT.test(file) || !existsSync(path))
      return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg').send(readFileSync(path));
  });

  app.post('/api/runs/:id/calibration', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const funnel = await getReport<FunnelReport>(db, id, 'funnel');
    if (!funnel) return reply.code(404).send({ error: 'NO_FUNNEL_REPORT' });
    const text = (req.body as { text?: unknown } | undefined)?.text;
    let real;
    try {
      real = parseAggregates(String(text ?? ''));
    } catch (e) {
      return reply
        .code(400)
        .send({ error: 'INVALID_AGGREGATES', message: (e as Error).message.slice(0, 500) });
    }
    const report = buildCalibration(funnel, real);
    await saveCalibration(db, id, req.operator, real);
    await saveReport(db, id, 'calibration', report);
    await audit(db, req.operator, 'run.calibrate', { id });
    return { report };
  });

  app.get('/api/compare', async (req, reply) => {
    const q = req.query as { a?: string; b?: string; format?: string };
    const [a, b] = await Promise.all([
      getReport<FunnelReport>(db, q.a ?? '', 'funnel'),
      getReport<FunnelReport>(db, q.b ?? '', 'funnel'),
    ]);
    if (!a || !b) return reply.code(404).send({ error: 'NO_FUNNEL_REPORT' });
    const report = buildComparison(a, b);
    return q.format === 'html'
      ? send(
          reply,
          report,
          a.meta.runId,
          'html',
          langOf(req.query),
          `${a.meta.runId}-vs-${b.meta.runId}`,
        )
      : report;
  });
}
