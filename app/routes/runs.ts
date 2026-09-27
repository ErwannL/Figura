import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { base36Id } from '../../shared/crypto.js';
import { runConfigSchema, type RunConfig } from '../../shared/run-config.js';
import { applyTarget, publicTargets } from '../../shared/targets.js';
import { purgeScreenshots } from '../../worker/runner.js';
import type { SimData } from '../../worker/data.js';
import { PRESETS } from '../../fake-orqea/scenario.js';
import {
  DEVICE_KEYS,
  EXPLORER_CAPS,
  EXPLORER_DEFAULTS,
  EXPLORER_DEVICES,
} from '../../shared/explorer.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/pool.js';
import { eventsOf } from '../db/events.js';
import { audit } from '../db/misc.js';
import { allPersonas } from '../db/vigie.js';
import {
  createRun,
  deleteRun,
  getRun,
  listRuns,
  requestCancel,
  transition,
  transitionsOf,
  type RunRow,
} from '../db/runs.js';

/** What the UI sees of a run (no internal columns). */
export function publicRun(r: RunRow) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    label: r.config.label,
    seed: r.seed,
    targetUrl: r.target_url,
    config: r.config,
    catalogueVersion: r.catalogue_version,
    weightsVersion: r.weights_version,
    targetVersion: r.target_version,
    refusalCode: r.refusal_code,
    refusalMessage: r.refusal_message,
    error: r.error,
    summary: r.summary,
    progress: r.progress,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function runRoutes(app: FastifyInstance, cfg: AppConfig, db: Db, data: SimData): void {
  runRoutes1(app, cfg, db, data);
  runRoutes2(app, cfg, db);
}

function runRoutes1(app: FastifyInstance, cfg: AppConfig, db: Db, data: SimData): void {
  /** Who is signed in, and which Orqea the console was inspecting (preselected for new runs). */
  app.get('/api/me', async (req) => ({
    operator: req.operator,
    target: req.sessionTarget,
    targetConfigured: req.sessionTarget === null ? null : req.sessionTarget in cfg.targets,
    targets: publicTargets(cfg.targets),
  }));

  app.get('/api/meta', async () => ({
    personas: (await allPersonas(db, data.personas)).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      locale: p.locale,
      device: p.device,
      goal: p.goal,
      weight: p.populationWeight,
    })),
    catalogue: {
      version: data.catalogue.version,
      useCases: data.catalogue.useCases.map((u) => ({
        id: u.id,
        title: u.title,
        planGate: u.planGate,
      })),
    },
    weightsVersion: data.weights.version,
    scenarios: Object.keys(PRESETS),
    explorer: {
      devices: DEVICE_KEYS.map((key) => ({ key, label: EXPLORER_DEVICES[key].label })),
      caps: EXPLORER_CAPS,
      defaults: EXPLORER_DEFAULTS,
    },
  }));

  app.get('/api/runs', async () => ({
    runs: (await listRuns(db, cfg.maxRunsListed)).map(publicRun),
  }));

  app.post('/api/runs', async (req, reply) => {
    const resolved = applyTarget(
      (req.body as { config?: unknown } | undefined)?.config,
      cfg.targets,
    );
    if ('error' in resolved) return reply.code(400).send(resolved);
    const parsed = runConfigSchema.safeParse(resolved.config);
    if (!parsed.success)
      return reply.code(400).send({
        error: 'INVALID_CONFIG',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    const config: RunConfig = parsed.data;
    const personas = await allPersonas(db, data.personas);
    const unknown = config.personaIds.filter((id) => !personas.some((p) => p.id === id));
    if (unknown.length)
      return reply
        .code(400)
        .send({ error: 'INVALID_CONFIG', issues: [`personaIds: unknown ${unknown.join(', ')}`] });
    const seed = config.seed ?? randomInt(0, 2 ** 31);
    const id = base36Id();
    // One active exploration per target (partial unique index, migration 004).
    if (!(await createRun(db, id, config, seed, req.operator)))
      return reply.code(409).send({ error: 'EXPLORATION_ACTIVE' });
    const run = await transition(db, id, 'queued', req.operator, 'queued from UI');
    await audit(db, req.operator, 'run.create', {
      id,
      kind: config.kind,
      target: config.targetUrl,
      targetName: config.target,
      seed,
    });
    return reply.code(201).send({ run: publicRun(run) });
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const run = await getRun(db, (req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { run: publicRun(run), transitions: await transitionsOf(db, run.id) };
  });
}

function runRoutes2(app: FastifyInstance, cfg: AppConfig, db: Db): void {
  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const run = await requestCancel(db, id, req.operator);
    if (!run) return reply.code(404).send({ error: 'NOT_FOUND' });
    await audit(db, req.operator, 'run.cancel', { id });
    return { run: publicRun(run) };
  });

  app.delete('/api/runs/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await deleteRun(db, id))) return reply.code(409).send({ error: 'NOT_DELETABLE' });
    purgeScreenshots(cfg.screenshotsDir, id);
    await audit(db, req.operator, 'run.delete', { id });
    return { deleted: true };
  });

  app.get('/api/runs/:id/events', async (req) => {
    const persona = (req.query as { persona?: string }).persona ?? null;
    return { events: await eventsOf(db, (req.params as { id: string }).id, persona) };
  });
}
