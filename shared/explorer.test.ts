import { describe, expect, it } from 'vitest';
import {
  ANOMALY_TYPES,
  DEVICE_KEYS,
  EXPLORER_CAPS,
  EXPLORER_DEVICES,
  explorerConfigSchema,
  planSessions,
} from './explorer.js';
import { runConfigSchema } from './run-config.js';

const base = { targetUrl: 'http://localhost:4100' };

describe('explorer device catalogue', () => {
  it('has immutable keys with a label and a profile or a viewport', () => {
    expect(DEVICE_KEYS).toEqual(['desktop', 'tablet', 'mobile']);
    expect(EXPLORER_DEVICES.desktop.viewport).toEqual({ width: 1440, height: 900 });
    for (const k of DEVICE_KEYS) {
      const d = EXPLORER_DEVICES[k];
      expect(d.label.en && d.label.fr).toBeTruthy();
      expect(d.profile !== null || d.viewport !== null).toBe(true);
    }
  });
});

describe('explorer config (server-side caps)', () => {
  it('defaults: desktop, 1 session, 150 actions, 10 minutes', () => {
    expect(explorerConfigSchema.parse({})).toEqual({
      devices: ['desktop'],
      sessions: 1,
      maxActions: 150,
      maxMinutes: 10,
      seedData: false,
      clumsiness: 0.05,
      replay: null,
    });
  });

  it('refuses more than 3 sessions, 500 actions, 30 minutes, no device, unknown device', () => {
    const bad = [
      { sessions: 4 },
      { sessions: 0 },
      { maxActions: 501 },
      { maxMinutes: 31 },
      { devices: [] },
      { devices: ['watch'] },
      { clumsiness: 0.5 },
      { replay: { device: 'mobile', slot: 3, untilStep: 1 } },
      { force: true },
    ];
    for (const b of bad)
      expect(explorerConfigSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(EXPLORER_CAPS.sessions).toBe(3);
    expect(
      explorerConfigSchema.parse({ sessions: 3, maxActions: 500, maxMinutes: 30 }).sessions,
    ).toBe(3);
  });

  it('an explore run always carries explorer parameters; other kinds never do', () => {
    expect(runConfigSchema.parse({ ...base, kind: 'explore' }).explorer?.maxActions).toBe(150);
    expect(
      runConfigSchema.parse({ ...base, kind: 'journey', explorer: { sessions: 2 } }).explorer,
    ).toBeNull();
    expect(
      runConfigSchema.safeParse({ ...base, kind: 'explore', explorer: { sessions: 9 } }).success,
    ).toBe(false);
  });

  it('dedupes devices and spreads sessions round-robin; a replay is one session', () => {
    const c = explorerConfigSchema.parse({ devices: ['mobile', 'desktop', 'mobile'], sessions: 3 });
    expect(c.devices).toEqual(['mobile', 'desktop']);
    expect(planSessions(c)).toEqual([
      { device: 'mobile', slot: 0, maxActions: 150 },
      { device: 'desktop', slot: 0, maxActions: 150 },
      { device: 'mobile', slot: 1, maxActions: 150 },
    ]);
    const r = explorerConfigSchema.parse({
      sessions: 3,
      replay: { device: 'tablet', slot: 1, untilStep: 12 },
    });
    expect(planSessions(r)).toEqual([{ device: 'tablet', slot: 1, maxActions: 12 }]);
  });

  it('gives every anomaly type a severity', () => {
    expect(new Set(Object.values(ANOMALY_TYPES))).toEqual(new Set(['critical', 'major', 'minor']));
  });
});
