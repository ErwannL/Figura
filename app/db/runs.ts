import type { Db } from './pool.js';
import {
  FINAL_STATUSES,
  TRANSITIONS,
  type RunConfig,
  type RunStatus,
} from '../../shared/run-config.js';

export interface RunRow {
  id: string;
  kind: string;
  status: RunStatus;
  seed: number;
  config: RunConfig;
  target_url: string;
  catalogue_version: string | null;
  weights_version: string | null;
  target_version: string | null;
  refusal_code: string | null;
  refusal_message: string | null;
  error: string | null;
  summary: Record<string, unknown> | null;
  /** Explorer runs: live progress (states, anomalies, last screenshot), written while running. */
  progress: Record<string, unknown> | null;
  cancel_requested: boolean;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const fromRow = (r: RunRow): RunRow => ({ ...r, seed: Number(r.seed) });

/**
 * Creates a draft run. Null when a unique index refuses it: an exploration of the same target is
 * already active (migration 004).
 */
export async function createRun(
  db: Db,
  id: string,
  config: RunConfig,
  seed: number,
  actor: string,
): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>(
    `insert into runs (id, kind, status, seed, config, target_url, created_by) values ($1, $2, 'draft', $3, $4, $5, $6) on conflict do nothing returning *`,
    [id, config.kind, seed, config, config.targetUrl, actor],
  );
  if (!rows[0]) return null;
  await db.query(
    `insert into run_transitions (run_id, from_status, to_status, actor, note) values ($1, null, 'draft', $2, 'created')`,
    [id, actor],
  );
  return fromRow(rows[0]);
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const { rows } = await db.query<RunRow>('select * from runs where id = $1', [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listRuns(db: Db, limit = 50): Promise<RunRow[]> {
  const { rows } = await db.query<RunRow>('select * from runs order by created_at desc limit $1', [
    limit,
  ]);
  return rows.map(fromRow);
}

export class TransitionError extends Error {}

/** Moves a run to `to` if its current status allows it; one audited row per transition. */
export async function transition(
  db: Db,
  id: string,
  to: RunStatus,
  actor: string,
  note: string | null = null,
  extra: Partial<
    Pick<
      RunRow,
      | 'refusal_code'
      | 'refusal_message'
      | 'error'
      | 'summary'
      | 'catalogue_version'
      | 'weights_version'
      | 'target_version'
    >
  > = {},
): Promise<RunRow> {
  const from = (Object.keys(TRANSITIONS) as RunStatus[]).filter((s) => TRANSITIONS[s].includes(to));
  const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 4}`);
  const finished = FINAL_STATUSES.includes(to) ? ', finished_at = now()' : '';
  const { rows } = await db.query<RunRow & { previous: RunStatus }>(
    `with prev as (select id, status from runs where id = $1 for update)
     update runs r set status = $2${finished}${sets.length ? `, ${sets.join(', ')}` : ''}
     from prev where r.id = prev.id and prev.status = any($3::text[]) returning r.*, prev.status as previous`,
    [id, to, from, ...Object.values(extra)],
  );
  const row = rows[0];
  if (!row) {
    const current = await getRun(db, id);
    throw new TransitionError(`Run ${id}: cannot go from ${current?.status ?? 'missing'} to ${to}`);
  }
  await db.query(
    'insert into run_transitions (run_id, from_status, to_status, actor, note) values ($1, $2, $3, $4, $5)',
    [id, row.previous, to, actor, note],
  );
  const { previous: _previous, ...run } = row;
  return fromRow(run as RunRow);
}

/** Claims the oldest queued run (SELECT … FOR UPDATE SKIP LOCKED) and moves it to preparing. */
export async function claimNext(db: Db, worker: string): Promise<RunRow | null> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<RunRow>(
      `update runs set status = 'preparing', started_at = now(), heartbeat_at = now()
       where id = (select id from runs where status = 'queued' order by created_at for update skip locked limit 1) returning *`,
    );
    const run = rows[0];
    if (run) {
      await client.query(
        `insert into run_transitions (run_id, from_status, to_status, actor, note) values ($1, 'queued', 'preparing', $2, 'claimed')`,
        [run.id, worker],
      );
    }
    await client.query('commit');
    return run ? fromRow(run) : null;
  } finally {
    client.release();
  }
}

export async function requestCancel(db: Db, id: string, actor: string): Promise<RunRow | null> {
  const run = await getRun(db, id);
  if (!run || FINAL_STATUSES.includes(run.status)) return run;
  await db.query('update runs set cancel_requested = true where id = $1', [id]);
  if (run.status === 'draft' || run.status === 'queued')
    return transition(db, id, 'cancelled', actor, 'cancelled before start');
  return getRun(db, id);
}

export async function isCancelRequested(db: Db, id: string): Promise<boolean> {
  const { rows } = await db.query<{ cancel_requested: boolean }>(
    'select cancel_requested from runs where id = $1',
    [id],
  );
  return rows[0]?.cancel_requested === true;
}

export async function setProgress(
  db: Db,
  id: string,
  progress: Record<string, unknown>,
): Promise<void> {
  await db.query('update runs set progress = $2, heartbeat_at = now() where id = $1', [
    id,
    progress,
  ]);
}

export async function heartbeat(db: Db, id: string): Promise<void> {
  await db.query('update runs set heartbeat_at = now() where id = $1', [id]);
}

/** Runs whose worker vanished (no heartbeat) in an active state. */
export async function staleRuns(db: Db, olderThanSeconds: number): Promise<RunRow[]> {
  const { rows } = await db.query<RunRow>(
    `select * from runs where status in ('preparing', 'running', 'reporting', 'cleaning') and heartbeat_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return rows.map(fromRow);
}

export async function transitionsOf(
  db: Db,
  id: string,
): Promise<
  { from_status: string | null; to_status: string; actor: string; note: string | null; at: Date }[]
> {
  const { rows } = await db.query(
    'select from_status, to_status, actor, note, at from run_transitions where run_id = $1 order by id',
    [id],
  );
  return rows;
}

export async function deleteRun(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `delete from runs where id = $1 and status = any($2::text[])`,
    [id, FINAL_STATUSES],
  );
  return rowCount === 1;
}
