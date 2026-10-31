import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

export function registerStreamingWheelJourney(context) {
  test('streaming commit between trusted wheel and scroll preserves the reader movement', async () => {
    const page = await context.browser().newPage({ viewport: { width: 1000, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__streamingWheelInputs = [];
      document.addEventListener('wheel', (event) => {
        window.__streamingWheelInputs.push({ trusted: event.isTrusted, deltaY: event.deltaY });
      });
    });
    const evidenceDir = process.env.CHAT_SCROLL_EVIDENCE_DIR;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    const records = Array.from({ length: 80 }, (_, index) => ({
      id: `scroll-${index + 1}`,
      from: { kind: 'agent', catId: 'codex-astra' },
      catId: 'codex-astra',
      type: 'assistant',
      content: `Reading message ${index + 1}`,
      timestamp: index + 1,
      ...(index === 79
        ? {
            origin: 'stream',
            lifecycle: {
              kind: 'response',
              orderKey: '80:scroll-80',
              invocationId: 'wheel-turn',
              targetId: 'codex-astra',
              inputEntryIds: [],
              inputMessageIds: [],
              startedAt: 80,
              status: 'processing',
            },
          }
        : {}),
    }));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, context.origin, 'all traffic stays in the local fixture');
      assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/proof.js') {
        return route.fulfill({ contentType: 'text/javascript', body: context.bundle() });
      }
      if (url.pathname.startsWith('/api/')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            url.pathname === '/api/messages'
              ? { messages: records, hasMore: false }
              : { userId: 'fixture-owner', tasks: [], cats: [], activeInvocations: [], queue: [] },
          ),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>[data-message-viewport-boundary]{display:flow-root;content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    try {
      await page.goto(`${context.origin}/${context.threadId}?scroll=1&streamAtWheel=1`);
      await page.locator('[data-message-id="scroll-80"]').waitFor();
      await page.waitForTimeout(750);
      const viewport = page.locator('[data-scroll-chat]');
      const before = await viewport.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight }));
      if (evidenceDir) await page.screenshot({ path: path.join(evidenceDir, 'before-wheel.png') });
      const bounds = await viewport.boundingBox();
      assert.ok(bounds);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, -320);
      await page.waitForTimeout(500);
      const after = await viewport.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        content: el.querySelector('[data-message-id="scroll-80"]').textContent.length,
      }));
      console.log(JSON.stringify({ journey: 'streaming-wheel', before, after }));
      const inputs = await page.evaluate(() => window.__streamingWheelInputs);
      if (evidenceDir) {
        await page.screenshot({ path: path.join(evidenceDir, 'after-wheel.png') });
        writeFileSync(path.join(evidenceDir, 'observation.json'), JSON.stringify({ before, after, inputs }));
      }
      assert.deepEqual(inputs, [{ trusted: true, deltaY: -320 }]);
      assert.ok(after.content > 10_000, 'the production store update rendered new output');
      assert.ok(after.height > before.height, 'real browser layout grew during the input');
      assert.ok(
        after.top < before.top - 250,
        'the upward wheel must move upward, without being reclaimed by bottom follow',
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
