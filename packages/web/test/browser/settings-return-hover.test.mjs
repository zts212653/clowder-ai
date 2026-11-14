import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';
import { registerShortSettingsReturnCase } from './settings-short-return.case.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://settings-return-hover.test';
const messages = Array.from({ length: 12 }, (_, index) => ({
  id: `reading-${index}`,
  type: 'assistant',
  catId: 'codex-astra',
  from: { kind: 'agent', catId: 'codex-astra' },
  content: `Reading message ${index}`,
  timestamp: index + 1,
}));
let browser;
let bundle;

before(async () => {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(root, 'src') } },
    define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(root, 'test/browser/fixtures/settings-return-hover.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  bundle = result.output.find((item) => item.type === 'chunk' && item.isEntry)?.code;
  assert.ok(bundle);
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());
registerShortSettingsReturnCase({ browser: () => browser, bundle: () => bundle, origin });

for (const input of ['hover', 'click', 'timeout', 'timeout-click']) {
  test(`Settings return with native ${input} while history is pending`, { timeout: 15000 }, async () => {
    const page = await browser.newPage();
    const errors = [];
    const reports = [];
    let holdHistory = false;
    let pendingHistory;
    let historyAttempts = 0;
    let retryArrived;
    const retryReady = new Promise((resolve) => {
      retryArrived = resolve;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, origin, 'no live service access');
      if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (url.pathname === '/api/messages' && holdHistory) {
        historyAttempts++;
        if (historyAttempts === 2) retryArrived();
        pendingHistory = route;
        return;
      }
      if (url.pathname === '/api/diagnostics/connection') {
        reports.push(...route.request().postDataJSON().events);
        return route.fulfill({ status: 204 });
      }
      if (url.pathname.startsWith('/api/')) {
        const body =
          url.pathname === '/api/evidence/navigation-source'
            ? { status: 'available', updated: false, target: { threadId: 'return-hover' } }
            : { messages, hasMore: false, tasks: [], cats: [], activeInvocations: [], queue: [] };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    });
    try {
      await page.goto(origin);
      const reading = page.getByTestId('reading');
      await page.locator('[data-message-id="reading-11"]').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="reading"]')?.dataset.loading === 'false');
      await reading.hover();
      await page.mouse.wheel(0, -700);
      await page.waitForFunction(() => {
        const saved = JSON.parse(localStorage.getItem('cat-cafe:thread-scroll:return-hover') ?? 'null');
        return saved?.state.anchor === 'offset' && Boolean(saved.state.messageAnchor);
      });
      const captured = await reading.evaluate((el) => {
        const row = [...el.querySelectorAll('[data-message-viewport-id]')].find(
          (node) => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top,
        );
        return {
          id: row.dataset.messageViewportId,
          offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top,
        };
      });
      await page.getByRole('button', { name: 'Open Settings' }).click();
      assert.equal(await page.getByTestId('return-state').getAttribute('data-source'), 'true');
      holdHistory = true;
      if (input.startsWith('timeout')) await page.clock.install();
      const requested = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/messages');
      await page.getByRole('button', { name: 'Return to conversation' }).click();
      await requested;
      await reading.waitFor();
      if (input.startsWith('timeout')) {
        const retry = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/messages');
        await page.clock.fastForward(30_020);
        await retry;
        await retryReady;
        assert.equal(historyAttempts, 2, 'exactly one retry follows the real browser timeout');
        assert.equal(await page.getByTestId('return-state').getAttribute('data-returning'), 'true');
        assert.equal(await page.getByTestId('return-state').getAttribute('data-notice'), '');
      }
      const box = await reading.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + 100, box.y + 80);
      await page.mouse.move(box.x + 100, box.y + 140);
      const clicks = input === 'click' || input === 'timeout-click';
      if (clicks) await page.mouse.click(box.x + 100, box.y + 160);
      assert.ok(pendingHistory, 'the real history request must be held before native input');
      if (clicks) {
        await page.waitForFunction(
          () => document.querySelector('[data-testid="return-state"]')?.dataset.returning === 'false',
        );
        assert.equal(await page.getByTestId('return-state').getAttribute('data-notice'), 'interrupted');
        assert.equal(await page.getByTestId('return-state').getAttribute('data-source'), 'true');
      } else {
        assert.equal(await page.getByTestId('return-state').getAttribute('data-returning'), 'true');
      }
      holdHistory = false;
      await pendingHistory.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ messages, hasMore: false }),
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="return-state"]')?.dataset.returning === 'false',
      );
      const state = await page.getByTestId('return-state').evaluate((el) => ({ ...el.dataset }));
      const retained = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('cat-cafe:connection-diagnostics:v1') ?? '[]'),
      );
      const readingRecords = [...new Map([...reports, ...retained].map((r) => [r.eventId, r])).values()].filter(
        (r) => r.kind === 'reading_restore',
      );
      assert.equal(new Set(readingRecords.map((r) => r.operationId)).size, 1);
      if (clicks)
        assert.ok(
          readingRecords.some((r) => r.phase === 'cancel' && r.cancelSource === 'native_input' && r.inputTrusted),
        );
      if (clicks) {
        assert.equal(state.notice, 'interrupted');
        assert.equal(state.source, 'true');
      } else {
        assert.equal(state.notice, '', 'native hover must not publish a Return to conversation error');
        assert.equal(state.source, 'false', 'the exact restore consumes its retained source');
        const offset = await page
          .locator(`[data-message-viewport-id="${captured.id}"]`)
          .evaluate((row) => row.getBoundingClientRect().top - row.closest('main').getBoundingClientRect().top);
        assert.ok(Math.abs(offset - captured.offset) <= 1, JSON.stringify({ captured, offset }));
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
