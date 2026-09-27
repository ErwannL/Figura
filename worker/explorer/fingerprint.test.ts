import { describe, expect, it } from 'vitest';
import { actionKey, fingerprint, normalizeRoute } from './fingerprint.js';
import { control } from './test-helpers/controls.js';

describe('normalizeRoute', () => {
  it('replaces ids, keeps screen query values, drops other values, sorts keys', () => {
    expect(normalizeRoute('http://x/board/42')).toBe('/board/:id');
    expect(normalizeRoute('http://x/card/b12/')).toBe('/card/:id');
    expect(normalizeRoute('http://x/f/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/f/:id');
    expect(normalizeRoute('http://x/share/aB3dEfGhIjKlMnOpQrStU')).toBe('/share/:id');
    expect(normalizeRoute('http://x/settings?tab=privacy&z=1&a=2&a=3')).toBe(
      '/settings?a&tab=privacy&z',
    );
    expect(normalizeRoute('http://x/')).toBe('/');
    expect(normalizeRoute('http://x/dashboard#top')).toBe('/dashboard');
  });
});

describe('fingerprint', () => {
  const scan = (o: object = {}) => ({
    url: 'http://x/board/1',
    modal: false,
    controls: [control({ name: 'A' }), control({ role: 'link', name: 'B' })],
    ...o,
  });
  it('is stable across ids, control order and duplicates', () => {
    const a = fingerprint(scan());
    expect(fingerprint(scan({ url: 'http://x/board/2' }))).toBe(a);
    expect(
      fingerprint(
        scan({
          controls: [
            control({ role: 'link', name: 'B' }),
            control({ name: 'A' }),
            control({ name: 'A' }),
          ],
        }),
      ),
    ).toBe(a);
    expect(a).toMatch(/^[0-9a-z]{7}$/);
  });
  it('changes with the route, the controls or a modal', () => {
    const a = fingerprint(scan());
    expect(fingerprint(scan({ url: 'http://x/dashboard' }))).not.toBe(a);
    expect(fingerprint(scan({ modal: true }))).not.toBe(a);
    expect(fingerprint(scan({ controls: [control({ name: 'A' })] }))).not.toBe(a);
  });
  it('action keys carry the link route', () => {
    expect(actionKey(control({ name: 'Go' }))).toBe('button:Go');
    expect(actionKey(control({ role: 'link', name: 'Go', href: 'http://x/board/9' }))).toBe(
      'link:Go→/board/:id',
    );
  });
});
