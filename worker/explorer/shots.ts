import { join } from 'node:path';
import { readdirSync, rmSync, statSync } from 'node:fs';
import type { Page } from 'playwright';
import type { DeviceKey } from '../../shared/explorer.js';
import { settleForShot } from '../drivers/settle.js';

/** `setup` : what the page showed when a session could not even sign up (the evidence of why). */
export type ShotKind = 'state' | 'after' | 'full' | 'setup';

export interface Shot {
  file: string;
  session: string;
  device: DeviceKey;
  step: number;
  route: string;
  fingerprint: string;
  action: string;
  kind: ShotKind;
}

/** Explorer screenshots are `x-<device>-<slot>-<step>-<kind>.png` in the run's directory. */
export const SHOT_FILE = /^x-[a-z]+-\d-\d{4}-(state|after|full|setup)\.png$/;

/** Screenshots of one run: one per new state and device, bounded in number. */
export class ShotBook {
  private seen = new Set<string>();
  readonly shots: Shot[] = [];

  constructor(
    private readonly dir: string,
    private readonly max = 400,
  ) {}

  /** True the first time a state is seen on a device (then it deserves a screenshot). */
  firstSight(device: DeviceKey, fingerprint: string): boolean {
    const key = `${device}|${fingerprint}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  async take(page: Page, meta: Omit<Shot, 'file'>): Promise<string | null> {
    if (this.shots.length >= this.max) return null;
    const [device, slot] = meta.session.split('#') as [string, string];
    const file = `x-${device}-${slot}-${String(meta.step).padStart(4, '0')}-${meta.kind}.png`;
    try {
      await settleForShot(page);
      await page.screenshot({
        path: join(this.dir, file),
        type: 'png',
        fullPage: meta.kind === 'full',
      });
    } catch {
      // The page closed or navigated away mid-capture: no evidence, the run goes on.
      return null;
    }
    this.shots.push({ file, ...meta });
    return file;
  }
}

/** Retention: explorer screenshots older than `days` are deleted (run directories kept). */
export function purgeExplorerShots(root: string, days: number, nowMs: number): number {
  let removed = 0;
  let runs: string[];
  try {
    runs = readdirSync(root);
  } catch {
    return 0;
  }
  for (const run of runs) {
    const dir = join(root, run);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      if (!SHOT_FILE.test(f) || nowMs - statSync(path).mtimeMs < days * 86_400_000) continue;
      rmSync(path, { force: true });
      removed += 1;
    }
  }
  return removed;
}
