import type { Page } from 'playwright';

/**
 * Waits for the page to be visually ready before a screenshot. A single-page app is blank at
 * `domcontentloaded` (its modules and first API calls are still in flight): a capture taken there
 * is a white rectangle, which is exactly what the run page used to show. Best effort and bounded:
 * a page that never goes quiet (polling, websockets) is captured as it is after `ms`.
 */
export async function settleForShot(
  page: Pick<Page, 'waitForLoadState'>,
  ms = 8000,
): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: ms });
  } catch {
    // never idle within the bound: take the picture anyway
  }
}
