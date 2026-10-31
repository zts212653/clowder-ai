import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import './reply-navigation-owner.cases.mjs';

test(
  'real Append region exposes exact read status in text at desktop and mobile widths',
  { timeout: 60000 },
  async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const require = createRequire(path.join(root, 'package.json'));
    const tailwind = require('tailwindcss');
    const config = require(path.join(root, 'tailwind.config.js'));
    const origin = 'https://append-read.test';
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(root, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      css: {
        postcss: {
          plugins: [
            tailwind({
              ...config,
              content: [
                path.join(root, 'src/**/*.{ts,tsx}'),
                path.join(root, 'test/browser/fixtures/append-read-status.tsx'),
              ],
            }),
          ],
        },
      },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(root, 'test/browser/fixtures/append-read-status.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = result.output;
    const bundle = output.find((item) => item.type === 'chunk' && item.isEntry);
    const css = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    assert.match(css, /@keyframes pulse/, 'test must load the real Tailwind animation');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 650 } });
      const errors = [];
      let retryPosts = 0;
      page.on('pageerror', (err) => errors.push(err.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin);
        if (url.pathname.endsWith('/repeat')) {
          assert.equal(url.pathname, '/api/threads/thread/messages/supported/routing-targets/opus/repeat');
          assert.equal(route.request().method(), 'POST');
          retryPosts++;
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: '{"status":"repeated","messageId":"new-input","entryId":"q-new"}',
          });
          return;
        }
        assert.equal(route.request().method(), 'GET');
        if (url.pathname === '/api/threads/thread/queue' && retryPosts > 0) {
          const original = {
            id: 'q1',
            threadId: 'thread',
            userId: 'owner',
            messageId: 'supported',
            content: '原消息',
            from: { kind: 'user', userId: 'owner' },
            targetCats: ['opus'],
            status: 'queued',
            createdAt: 20,
            autoExecute: true,
            intent: 'execute',
            priority: 'normal',
            mergedMessageIds: [],
          };
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              queue: [original, { ...original, id: 'q-new', messageId: 'new-input', createdAt: 24 }],
            }),
          });
          return;
        }
        const body =
          url.pathname === '/proof.js'
            ? bundle.code
            : url.pathname === '/proof.css'
              ? css
              : url.pathname.startsWith('/api/')
                ? JSON.stringify({ ok: true, name: 'lang', cats: [] })
                : '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>';
        await route.fulfill({
          body,
          contentType: url.pathname.endsWith('.js')
            ? 'text/javascript'
            : url.pathname.endsWith('.css')
              ? 'text/css'
              : url.pathname.startsWith('/api/')
                ? 'application/json'
                : 'text/html',
        });
      });
      await page.goto(origin);
      await page.locator('main[data-ready="true"]').waitFor();
      const supported = page.locator('[data-appended-input-id="supported"] button[data-append-delivery-state]');
      const unsupported = page.locator('[data-appended-input-id="unsupported"] button[data-append-delivery-state]');
      const supportedIndicator = supported.locator('span[aria-hidden="true"]');
      const unsupportedIndicator = unsupported.locator('span[aria-hidden="true"]');
      assert.equal(await supportedIndicator.evaluate((el) => getComputedStyle(el).animationName), 'none');
      assert.match(await page.locator('[data-append-read-status="pending"]').innerText(), /已收到，等读取确认/);
      assert.match(await page.locator('[data-append-read-status="unavailable"]').innerText(), /已收到，读没读查不到/);
      assert.equal(await supportedIndicator.evaluate((el) => getComputedStyle(el).width), '6px');
      assert.notEqual(
        await supportedIndicator.evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgba(0, 0, 0, 0)',
      );
      assert.equal(await unsupportedIndicator.evaluate((el) => getComputedStyle(el).animationName), 'none');
      await supported.focus();
      await page.getByRole('tooltip').waitFor();
      assert.match(await page.getByRole('tooltip').innerText(), /已收到，等读取确认/);
      await page.keyboard.press('Escape');
      await unsupported.hover();
      await page.getByRole('tooltip').waitFor();
      assert.match(await page.getByRole('tooltip').innerText(), /已收到，读没读查不到/);
      assert.equal(await unsupported.getAttribute('data-append-delivery-state'), 'unavailable');
      for (const width of [1100, 360]) {
        await page.setViewportSize({ width, height: 650 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.APPEND_READ_EVIDENCE_DIR) {
          await mkdir(process.env.APPEND_READ_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.APPEND_READ_EVIDENCE_DIR, `append-pending-${width}.png`),
            fullPage: true,
          });
        }
      }
      await supported.click();
      assert.match(await page.locator('[data-append-read-status="pending"]').innerText(), /已收到，等读取确认/);
      await page.getByRole('button', { name: 'terminal', exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-appended-input-id="supported"] [data-append-delivery-state]')
            ?.getAttribute('data-append-delivery-state') === 'unconfirmed',
      );
      assert.equal(await supportedIndicator.evaluate((el) => getComputedStyle(el).animationName), 'none');
      assert.match(await supported.getAttribute('aria-label'), /已收到，没确认读到/);
      assert.match(await page.locator('[data-append-read-status="unconfirmed"]').innerText(), /已收到，没确认读到/);
      await page.getByRole('button', { name: 'read', exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-appended-input-id="supported"] [data-append-delivery-state]')
            ?.getAttribute('data-append-delivery-state') === 'read',
      );
      assert.match(await supported.getAttribute('aria-label'), /已读 \d{2}:\d{2}/);
      assert.match(await page.locator('[data-append-read-status="read"]').innerText(), /✓ 已读/);
      assert.equal(await unsupported.getAttribute('data-append-delivery-state'), 'unavailable');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: 'pending', exact: true }).click();
      assert.equal(await supportedIndicator.evaluate((el) => getComputedStyle(el).animationName), 'none');
      await page.getByRole('button', { name: 'many', exact: true }).click();
      const list = page.locator('[data-testid="appended-input-list"]');
      for (const width of [1100, 360]) {
        await page.setViewportSize({ width, height: 650 });
        const measureRows = () =>
          list.evaluate((element) => ({
            visible: element.getBoundingClientRect().height,
            row: element.firstElementChild.getBoundingClientRect().height,
            total: element.scrollHeight,
          }));
        const folded = await measureRows();
        assert.ok(Math.abs(folded.visible / folded.row - 3.5) < 0.05, `${width}px shows 3.5 actual rows`);
        assert.ok(folded.total > folded.visible, 'older inputs remain available below the fold');
        await page.getByRole('button', { name: '展开剩余 2 条补充消息', exact: true }).click();
        const expanded = await measureRows();
        assert.ok(expanded.visible >= expanded.total - 1, 'expand reveals every source');
        await page.getByRole('button', { name: '收起补充消息', exact: true }).click();
        const refolded = await measureRows();
        assert.ok(Math.abs(refolded.visible / refolded.row - 3.5) < 0.05, 'collapse restores the partial-row cue');
      }
      assert.deepEqual(errors, []);
      await page.getByRole('button', { name: 'unknown-checking', exact: true }).click();
      const receipts = page.getByRole('article', { name: '原消息收件进度' });
      assert.match(await receipts.innerText(), /正在核对 砚砚 收到没…/);
      assert.equal(await receipts.getByRole('button', { name: '再发一次', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'unknown', exact: true }).click();
      await receipts.getByRole('button', { name: '再发一次', exact: true }).waitFor();
      assert.match(await receipts.innerText(), /已送出，没确认收到/);
      assert.doesNotMatch(await receipts.innerText(), /Agent Client|收到，正在回|没送到/);
      assert.match(await receipts.innerText(), /如果它其实收到了，会再回一遍/);
      assert.match(await page.locator('[data-appended-input-id="supported"]').innerText(), /已送出，没确认收到/);
      for (const width of [1100, 360]) {
        await page.setViewportSize({ width, height: 650 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.APPEND_READ_EVIDENCE_DIR)
          await page.screenshot({
            path: path.join(process.env.APPEND_READ_EVIDENCE_DIR, `append-unknown-${width}.png`),
            fullPage: true,
          });
      }
      await page.reload();
      await receipts.getByRole('button', { name: '再发一次', exact: true }).waitFor();
      assert.equal(retryPosts, 0, 'hydration never resends uncertain input');
      await page.getByRole('button', { name: 'unknown-read', exact: true }).click();
      assert.equal(await receipts.getByRole('button', { name: '再发一次', exact: true }).count(), 0);
      assert.match(await page.locator('[data-appended-input-id="supported"]').innerText(), /已读/);
      await page.getByRole('button', { name: 'unknown', exact: true }).click();
      await receipts.getByRole('button', { name: '再发一次', exact: true }).click();
      const repeated = page.getByRole('article', { name: '再次发送的新消息' });
      await repeated.waitFor();
      assert.equal(retryPosts, 1, 'the owner click sends exactly one request');
      assert.match(await repeated.innerText(), /排队中 · 等.*砚砚.*接/s);
      assert.match(await receipts.innerText(), /已送出，没确认收到/);
      assert.equal(await receipts.getByRole('button', { name: '再发一次', exact: true }).count(), 0);
      assert.equal(
        await page.locator('[data-appended-input-id="supported"]').count(),
        1,
        'the original receipt remains bound to its original run',
      );
      await page.reload();
      await repeated.waitFor();
      assert.equal(retryPosts, 1, 'reload does not create a third input');
      await page.getByRole('button', { name: 'queued', exact: true }).click();
      assert.match(await receipts.innerText(), /排队中 · 等.*砚砚.*接/s);
      assert.equal(await page.locator('[data-appended-input-id="supported"]').count(), 0);
      await page.reload();
      await receipts.locator('[data-dispatch-queued="q1"]').waitFor();
      assert.equal(retryPosts, 1);
      assert.doesNotMatch(await receipts.innerText(), /没送到|待核对|再发一次/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
