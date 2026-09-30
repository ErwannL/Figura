import { chromium, type Browser } from 'playwright';

/**
 * One headless Chromium per run; each persona session gets its own context.
 * `LocalNetworkAccessChecks` is off: Figura's targets are local or staging stacks reached by
 * container names and rewritten origins, and Chromium's "local network access" rules would block
 * a page answered through the rewriting proxy from loading loopback or private-network resources.
 */
export async function launchBrowser(executablePath: string | undefined): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
}
