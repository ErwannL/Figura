import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHOT_FILE, ShotBook, purgeExplorerShots } from './shots.js';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => browser.close());

const meta = {
  session: 'mobile#1',
  device: 'mobile' as const,
  step: 7,
  route: '/',
  fingerprint: 'abc',
  action: 'tap',
};

describe('ShotBook', () => {
  it('names PNGs by device, slot, step and kind; one per state and device', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shots-'));
    const book = new ShotBook(dir);
    expect(book.firstSight('mobile', 'abc')).toBe(true);
    expect(book.firstSight('mobile', 'abc')).toBe(false);
    expect(book.firstSight('desktop', 'abc')).toBe(true);
    const page = await browser.newPage();
    await page.setContent('<p>hello</p>');
    expect(await book.take(page, { ...meta, kind: 'state' })).toBe('x-mobile-1-0007-state.png');
    expect(await book.take(page, { ...meta, kind: 'full' })).toBe('x-mobile-1-0007-full.png');
    expect(existsSync(join(dir, 'x-mobile-1-0007-full.png'))).toBe(true);
    expect(SHOT_FILE.test('x-mobile-1-0007-full.png')).toBe(true);
    expect(book.shots[0]).toMatchObject({
      file: 'x-mobile-1-0007-state.png',
      device: 'mobile',
      step: 7,
    });
    await page.close();
    // A closed page gives no evidence, and no error.
    expect(await book.take(page, { ...meta, kind: 'after' })).toBeNull();
    expect(book.shots).toHaveLength(2);
  });
});

describe('purgeExplorerShots (retention)', () => {
  it('deletes explorer screenshots older than the retention, nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'retention-'));
    mkdirSync(join(root, 'run1'));
    writeFileSync(join(root, 'stray.txt'), 'x');
    const old = join(root, 'run1', 'x-desktop-0-0001-state.png');
    const fresh = join(root, 'run1', 'x-desktop-0-0002-state.png');
    const journey = join(root, 'run1', 'student-1-landing.jpg');
    for (const f of [old, fresh, journey]) writeFileSync(f, 'x');
    const now = Date.now();
    const days = (n: number) => (now - n * 86_400_000) / 1000;
    utimesSync(old, days(15), days(15));
    utimesSync(journey, days(30), days(30));
    expect(purgeExplorerShots(root, 14, now)).toBe(1);
    expect([existsSync(old), existsSync(fresh), existsSync(journey)]).toEqual([false, true, true]);
    expect(purgeExplorerShots(join(root, 'missing'), 14, now)).toBe(0);
  });
});
