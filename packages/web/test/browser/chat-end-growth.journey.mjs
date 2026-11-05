import assert from 'node:assert/strict';
import { test } from 'node:test';

export function registerEndGrowthJourney({ origin, threadId, browser, bundle }) {
  test('native End retains the bottom destination while deferred message geometry grows', async () => {
    const page = await browser().newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    const records = Array.from({ length: 160 }, (_, index) => ({
      id: `growth-${index + 1}`,
      type: 'assistant',
      catId: 'codex-astra',
      timestamp: index + 1,
      content: `Growing reading message ${index + 1}`,
    }));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'growth proof must not access a live service');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle() });
      if (url.pathname.startsWith('/api/')) {
        const body =
          url.pathname === '/api/messages'
            ? { messages: records, hasMore: false }
            : { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>
          [data-message-viewport-boundary]{content-visibility:auto;display:flow-root}
          article{box-sizing:border-box;min-height:420px!important}
        </style><div id="root"></div><script type="module" src="/proof.js"></script>`,
      });
    });
    try {
      await page.goto(`${origin}/${threadId}?scroll=1`);
      const chat = page.locator('[data-scroll-chat]');
      await page.locator('[data-message-id="growth-160"]').waitFor();
      await chat.hover();
      await page.mouse.wheel(0, -1000000);
      await page.waitForFunction(() => document.querySelector('[data-scroll-chat]').scrollTop === 0);
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(300);
      await chat.click({ position: { x: 8, y: 260 } });
      const before = await chat.evaluate((el) => ({
        top: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
      }));
      assert.ok(before.top > 100 && before.max - before.top > 1000, JSON.stringify(before));
      await page.keyboard.press('End');
      let failure;
      try {
        await page.waitForFunction(
          (id) => {
            const el = document.querySelector('[data-scroll-chat]');
            const saved = JSON.parse(localStorage.getItem(`cat-cafe:thread-scroll:${id}`) || '{}').state;
            return el.scrollHeight - el.clientHeight - el.scrollTop <= 2 && saved?.anchor === 'bottom';
          },
          threadId,
          { timeout: 5000 },
        );
      } catch (error) {
        failure = error;
      }
      const after = await chat.evaluate(
        (el, id) => ({
          top: el.scrollTop,
          max: el.scrollHeight - el.clientHeight,
          saved: JSON.parse(localStorage.getItem(`cat-cafe:thread-scroll:${id}`) || '{}').state,
        }),
        threadId,
      );
      assert.ok(
        after.max > before.max + 100,
        `counterexample must grow the native destination: ${JSON.stringify({ before, after })}`,
      );
      assert.ok(!failure, `End must reach the expanded bottom: ${JSON.stringify({ before, after })}`);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
