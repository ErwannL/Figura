import { describe, expect, it, vi } from 'vitest';
import { settleForShot } from './settle.js';

describe('settleForShot', () => {
  it('waits for the network to go idle, bounded', async () => {
    const waitForLoadState = vi.fn().mockResolvedValue(undefined);
    await settleForShot({ waitForLoadState }, 123);
    expect(waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 123 });
  });

  it('never throws when the page never goes quiet', async () => {
    const waitForLoadState = vi.fn().mockRejectedValue(new Error('Timeout'));
    await expect(settleForShot({ waitForLoadState })).resolves.toBeUndefined();
    expect(waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 8000 });
  });
});
