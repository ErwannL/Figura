import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { SimData } from '../worker/data.js';
import { authRoutes } from './auth.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import { reportRoutes } from './routes/reports.js';
import { runRoutes } from './routes/runs.js';
import { vigieRoutes } from './routes/vigie.js';
import { securityHooks } from './security.js';

/** Logs never contain bodies, headers, cookies, tokens or query strings. */
export const loggerOptions = {
  level: 'info',
  serializers: {
    req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split('?')[0] }),
    res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
  },
};

export async function buildApp(
  cfg: AppConfig,
  deps: { db: Db; data: SimData; nowS: () => number; logger: boolean; ownsDb?: boolean },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ? loggerOptions : false,
    bodyLimit: 1_000_000,
    trustProxy: false,
  });
  await app.register(cookie);
  securityHooks(app, {
    loopbackOnly: cfg.loopbackOnly,
    consoleOrigins: cfg.consoleOrigins,
    vigieSecret: cfg.vigieSecret,
  });
  app.get('/health', async () => {
    await deps.db.query('select 1');
    // `orqeaUrl` is public (a link): it tells the UI which Orqea « Back to Orqea » goes to.
    return { ok: true, orqeaUrl: cfg.orqeaUrl };
  });
  authRoutes(app, cfg, deps.db, deps.nowS);
  runRoutes(app, cfg, deps.db, deps.data);
  vigieRoutes(app, cfg, deps.db, deps.data);
  reportRoutes(app, cfg, deps.db);
  if (existsSync(cfg.uiDir)) {
    // The UI shell holds no data; without a session it only says "open me from the console".
    await app.register(fastifyStatic, { root: cfg.uiDir, index: ['index.html'] });
  }
  if (deps.ownsDb) app.addHook('onClose', async () => deps.db.end());
  await app.ready();
  return app;
}
