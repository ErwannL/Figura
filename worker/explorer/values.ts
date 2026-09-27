import type { Prng } from '../../shared/prng.js';
import { HTML_MARKER_PREFIX } from './page-scan.js';

export type ValueKind = 'plausible' | 'empty' | 'long' | 'unicode' | 'html';

const WORDS = ['alpha', 'roadmap', 'sprint', 'review', 'design', 'budget', 'launch', 'notes'];

/** The kind of value to type: mostly plausible, sometimes an edge case. */
export function valueKind(prng: Prng, edgeRate = 0.2): ValueKind {
  if (!prng.chance(edgeRate)) return 'plausible';
  return prng.pick(['empty', 'long', 'unicode', 'html'] as const);
}

/**
 * A value for a field of that input type. Emails are always `@synthetic.invalid`; the HTML-looking
 * value carries a marker the page scan looks for (`<b>fxh…</b>` must show as text).
 */
export function fieldValue(prng: Prng, type: string, kind: ValueKind, runId: string): string {
  const t = type.toLowerCase();
  if (t === 'email') return `synth+${runId}-x${prng.int(1, 999)}@synthetic.invalid`;
  if (t === 'number')
    return kind === 'plausible' ? String(prng.int(1, 100)) : String(prng.pick([0, -1, 1e9]));
  if (t === 'date')
    return `2030-${String(prng.int(1, 12)).padStart(2, '0')}-${String(prng.int(1, 28)).padStart(2, '0')}`;
  if (t === 'url') return `https://example.invalid/${prng.pick(WORDS)}`;
  if (t === 'tel')
    return `+33 1 ${prng.int(10, 99)} ${prng.int(10, 99)} ${prng.int(10, 99)} ${prng.int(10, 99)}`;
  if (kind === 'empty') return '';
  if (kind === 'long') return 'x'.repeat(2000);
  if (kind === 'unicode') return 'Café ☕ 你好 — Ωmega 🚀 ñ';
  if (kind === 'html') return `<b>${HTML_MARKER_PREFIX}${prng.int(1000, 9999)}</b>`;
  const n = prng.int(1, t === 'textarea' ? 12 : 3);
  return Array.from({ length: n }, () => prng.pick(WORDS)).join(' ');
}
