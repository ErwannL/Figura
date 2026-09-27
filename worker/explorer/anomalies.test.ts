import { describe, expect, it } from 'vitest';
import { signRunHeader } from '../../shared/synthetic.js';
import { AnomalyBook, normalizeMessage, redact, safeUrl } from './anomalies.js';

const s = (o: object = {}) => ({
  type: 'js-error' as const,
  route: '/board/:id',
  message: 'TypeError at 12:4',
  device: 'desktop' as const,
  slot: 0,
  step: 3,
  action: 'button:Boom',
  ...o,
});

describe('anomaly dedup', () => {
  it('merges type + route + normalised message; counts and lists devices', () => {
    const b = new AnomalyBook();
    expect(b.add(s()).first).toBe(true);
    expect(b.add(s({ message: 'TypeError at 99:1', device: 'mobile', step: 9 })).first).toBe(false);
    b.add(s({ device: 'mobile' }));
    expect(b.size).toBe(1);
    const [a] = b.anomalies();
    expect(a).toMatchObject({
      count: 3,
      devices: ['desktop', 'mobile'],
      step: 3,
      severity: 'critical',
      excerpt: '',
      screenshots: [],
    });
    b.add(s({ route: '/dashboard' }));
    b.add(s({ type: 'small-target', message: 'x', screenshots: ['a.png'], excerpt: 'e' }));
    b.add(s({ type: 'trap', message: 'y' }));
    b.add(s({ type: 'trap', message: 'y' }));
    expect(b.anomalies().map((x) => x.type)).toEqual([
      'js-error',
      'js-error',
      'trap',
      'small-target',
    ]);
  });

  it('keeps info apart, deduplicated', () => {
    const b = new AnomalyBook();
    b.info('paywall', '/stats', '402 FEATURE_LOCKED');
    b.info('paywall', '/stats', '402 FEATURE_LOCKED');
    b.info('external-navigation', '/', 'https://example.com');
    expect(b.infoList()).toEqual([
      { type: 'paywall', route: '/stats', message: '402 FEATURE_LOCKED', count: 2 },
      { type: 'external-navigation', route: '/', message: 'https://example.com', count: 1 },
    ]);
    expect(b.size).toBe(0);
  });

  it('normalises digits, whitespace and URL queries', () => {
    expect(normalizeMessage('Error  42 at http://a/b?token=x#y')).toBe('error # at http://a/b');
  });
});

describe('redaction', () => {
  it('masks run headers, JWTs, bearer tokens, secret query params and fields, long hex', () => {
    const header = signRunHeader('r1', 's'.repeat(40), 1_900_000_000);
    const text = [
      `x-synthetic-run: ${header}`,
      header,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_1',
      'Authorization: Bearer abc.def',
      '/verify?token=abc123&x=1',
      '{"password":"hunter2"}',
      'a'.repeat(64),
    ].join('\n');
    const out = redact(text, 10_000);
    for (const secret of [header, 'eyJhbGci', 'abc.def', 'abc123', 'hunter2', 'a'.repeat(64)])
      expect(out).not.toContain(secret);
    expect(redact('x'.repeat(20), 5)).toBe('xxxxx…');
  });
  it('stores URLs without query', () => {
    expect(safeUrl('http://h:1/api/x?token=abc#f')).toBe('http://h:1/api/x');
  });
});
