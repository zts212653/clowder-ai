import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

test(
  'real delivery UI keeps missing or replaced execution on original response and folds timeout diagnostics',
  { timeout: 60000 },
  async () => {
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const origin = 'https://issue1371-settling.test';
    const result = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/issue1371-settling.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
    const bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    assert(bundle?.type === 'chunk');
    const css = outputs
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      const writes = [];
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        assert.equal(url.origin, origin);
        if (request.method() !== 'GET' && url.pathname !== '/api/auth/session') writes.push(request.method());
        const body =
          url.pathname === '/proof.js'
            ? bundle.code
            : url.pathname === '/proof.css'
              ? css
              : url.pathname.startsWith('/api/')
                ? JSON.stringify({ ok: true, userId: 'preview-owner', cats: [] })
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
      const target = page.locator('[data-dispatch-target="codex-astra"]');
      await target.waitFor({ state: 'visible' });
      assert.equal(await target.getAttribute('data-dispatch-phase'), 'processing');
      assert.equal(await page.locator('[data-testid="queue-recover"]').count(), 0);
      assert.equal(await page.locator('[data-queue-target-row="codex-astra"]').count(), 0);
      for (const width of [1100, 360]) {
        await page.setViewportSize({ width, height: 800 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.ISSUE1371_EVIDENCE_DIR) {
          await mkdir(process.env.ISSUE1371_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, `settling-${width}.png`),
            fullPage: true,
          });
        }
      }
      await page.getByRole('button', { name: '原执行结束但无回执', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-dispatch-target]')?.getAttribute('data-dispatch-phase') === 'delivered',
      );
      assert.equal(await page.locator('[data-queue-target-row]').count(), 0);
      await page.getByRole('button', { name: '同猫开始其他工作', exact: true }).click();
      assert.equal(await target.getAttribute('data-dispatch-phase'), 'delivered');
      assert.equal(await page.locator('[data-queue-target-row]').count(), 0);
      await page.getByRole('button', { name: '原回复超时', exact: true }).click();
      await page.getByText('回复失败。', { exact: true }).waitFor();
      assert.equal(await page.getByText('回复失败。', { exact: true }).count(), 1);
      assert.equal(await page.locator('[data-testid="diagnostics-panel"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.ISSUE1371_EVIDENCE_DIR) {
        await page.screenshot({
          path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, 'timeout-collapsed-360.png'),
          fullPage: true,
        });
      }
      await page.locator('[data-testid="diagnostics-toggle"]').click();
      await page.locator('[data-testid="diagnostics-panel"]').waitFor();
      assert.match(await page.locator('main').innerText(), /1846576ms/);
      assert.equal(await page.getByText('回复失败。', { exact: true }).count(), 1);
      if (process.env.ISSUE1371_EVIDENCE_DIR) {
        await page.screenshot({
          path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, 'timeout-expanded-360.png'),
          fullPage: true,
        });
      }
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
