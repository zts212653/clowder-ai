import { test } from 'node:test';

test(
  'watcher controls and shared receipts persist through real routes and isolated Redis in the browser',
  {
    timeout: 300000,
    skip: process.env.F335_BROWSER_WEB_URL ? false : 'manual browser lane: set F335_BROWSER_WEB_URL and use test:redis',
  },
  async () => {
    try {
      await import('../../../docs/evidence/2026-11-02-f335-watcher-awake/scripts/browser-check.mjs');
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
);
