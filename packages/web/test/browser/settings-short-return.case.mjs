import assert from 'node:assert/strict';
import { test } from 'node:test';

export function registerShortSettingsReturnCase({ browser, bundle, origin }) {
  test('short Settings return restores bottom zero before consuming its original source', async () => {
    const page = await browser().newPage();
    const messages = ['first', 'last'].map((id, timestamp) => ({
      id,
      timestamp,
      type: 'assistant',
      catId: 'codex61-sol',
      content: id,
    }));
    const errors = [];
    let holdHistory = false,
      releaseHistory;
    const gate = new Promise((resolve) => {
      releaseHistory = resolve;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'no production services');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle() });
      if (url.pathname === '/api/messages' && holdHistory) await gate;
      if (url.pathname.startsWith('/api/'))
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            url.pathname === '/api/evidence/navigation-source'
              ? { status: 'available', updated: false, target: { threadId: 'return-hover' } }
              : { messages, hasMore: false, tasks: [], cats: [], activeInvocations: [], queue: [] },
          ),
        });
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    try {
      await page.goto(origin);
      await page.locator('[data-message-id="last"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading"]')?.dataset.loading === 'false');
      assert.deepEqual(
        await page.getByTestId('reading').evaluate((el) => [el.scrollTop, el.scrollHeight, el.clientHeight]),
        [0, 360, 360],
      );
      await page.getByRole('button', { name: 'Open Settings', exact: true }).click();
      const before = await page.evaluate(() =>
        Object.entries(localStorage).filter(([key]) => key.startsWith('cat-cafe:thread-scroll-ref:')),
      );
      assert.equal(before.length, 1);
      assert.deepEqual(JSON.parse(before[0][1]).state, { top: 0, anchor: 'bottom' });
      holdHistory = true;
      await page.getByRole('button', { name: 'Return to conversation', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="return-state"]')?.dataset.returning === 'true',
      );
      assert.equal(await page.getByTestId('return-state').getAttribute('data-source'), 'true');
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), before[0][0]), before[0][1]);
      releaseHistory();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="return-state"]')?.dataset.source === 'false',
        null,
        { timeout: 4000 },
      );
      assert.equal(await page.getByTestId('return-state').getAttribute('data-notice'), '');
      assert.equal(await page.getByTestId('reading').evaluate((el) => el.scrollTop), 0);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), before[0][0]), null);
      assert.deepEqual(errors, []);
    } finally {
      releaseHistory();
      await page.close();
    }
  });
}
