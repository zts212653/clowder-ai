import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Home uses the same installed driver as the other Vite journeys. Public proofs
// can supply their own installed module through the existing explicit override.
const playwrightModule =
  process.env.CLASSIC_A2A_PLAYWRIGHT_MODULE ??
  new URL('../../../ppt-forge/node_modules/playwright/index.mjs', import.meta.url);
const { chromium } = await import(playwrightModule);

// Deterministic frontend rendering proof; no native provider or backend lifecycle claim.
test(
  'classic A2A controls render with source themes, real overflow and independent navigation',
  { timeout: 60000 },
  async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const origin = 'https://classic-a2a.test';
    const evidence = process.env.CLASSIC_A2A_EVIDENCE_DIR;
    const previousCwd = process.cwd();
    let built;
    process.chdir(root);
    try {
      built = await build({
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
            input: path.join(root, 'test/browser/fixtures/classic-a2a-parity.tsx'),
            output: { format: 'es', inlineDynamicImports: true },
          },
        },
      });
    } finally {
      process.chdir(previousCwd);
    }
    const script = built.output.find((item) => item.type === 'chunk' && item.isEntry).code;
    const css = built.output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const measurements = [];
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin);
        assert.equal(route.request().method(), 'GET');
        const body =
          url.pathname === '/proof.js'
            ? script
            : url.pathname === '/proof.css'
              ? css
              : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><div id="root"></div><script type="module" src="/proof.js"></script>';
        await route.fulfill({
          body,
          contentType: url.pathname.endsWith('.js')
            ? 'text/javascript'
            : url.pathname.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        });
      });
      await page.goto(origin);
      const long = page.getByTestId('long-pill').locator('button').first();
      await long.waitFor();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="long-pill"] button')?.getAttribute('aria-expanded') === 'false',
      );
      await long.focus();
      await page.keyboard.press('Enter');
      assert.equal(await long.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('[data-message-jump-focus]').count(), 0);
      assert.equal(
        await long
          .locator('span')
          .last()
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        true,
      );
      await page.getByTestId('long-pill').getByRole('button', { name: '跳到原文', exact: true }).click();
      assert.equal(await page.locator('[data-message-id="source-1"]').getAttribute('data-message-jump-focus'), 'true');
      await long.click();
      assert.equal(await long.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByTestId('short-pill').locator('button').getAttribute('aria-expanded'), null);
      assert.equal(await page.getByTestId('deleted-pill').locator('button').getAttribute('aria-expanded'), null);
      for (const [id, expected] of [
        ['human', 'rgb(209, 106, 69)'],
        ['member', 'rgb(81, 118, 184)'],
        ['external', 'rgb(100, 116, 139)'],
      ]) {
        assert.equal(
          await page
            .locator(`[data-appended-input-id="${id}"] button > span`)
            .first()
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          expected,
        );
      }
      await page.evaluate(() => document.documentElement.style.setProperty('--color-opus-primary', '#257A61'));
      assert.equal(
        await page
          .locator('[data-appended-input-id="member"] button > span')
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(37, 122, 97)',
      );
      const row = page.locator('[data-appended-input-id="human"] button[data-append-delivery-state]');
      assert.equal(await row.getAttribute('aria-expanded'), 'false');
      await row.click();
      assert.equal(await row.getAttribute('aria-expanded'), 'true');
      await row.click();
      for (const width of [1100, 360]) {
        await page.setViewportSize({ width, height: 900 });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
          await long.click();
          assert.equal(await long.getAttribute('aria-expanded'), 'true');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          if (evidence) {
            await mkdir(evidence, { recursive: true });
            await page.screenshot({
              path: path.join(evidence, `classic-expanded-${width}-${theme}.png`),
              fullPage: true,
            });
          }
          await long.click();
          await page.getByRole('button', { name: '添加内容', exact: true }).click();
          const dialog = page.getByRole('dialog');
          const metrics = await dialog.evaluate((el) => {
            const style = getComputedStyle(el),
              rect = el.getBoundingClientRect();
            return {
              background: style.backgroundColor,
              canvas: getComputedStyle(document.documentElement).getPropertyValue('--cafe-surface-canvas'),
              radius: style.borderRadius,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              viewport: innerWidth,
            };
          });
          assert.notEqual(metrics.background, 'rgba(0, 0, 0, 0)');
          assert.equal(metrics.radius, '16px');
          assert.ok(
            metrics.left >= 0 && metrics.right <= metrics.viewport && metrics.top >= 0 && metrics.bottom <= 900,
          );
          assert.deepEqual(
            await page.getByRole('menuitem').evaluateAll((items) => items.map((item) => item.dataset.testid)),
            ['composer-add-context', 'composer-upload', 'message-disposition-trigger', 'composer-whisper'],
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          measurements.push({ width, theme, ...metrics });
          if (evidence) {
            await mkdir(evidence, { recursive: true });
            await page.screenshot({ path: path.join(evidence, `classic-menu-${width}-${theme}.png`), fullPage: true });
          }
          await page.keyboard.press('Escape');
          assert.equal(await dialog.count(), 0);
          assert.equal(
            await page
              .getByRole('button', { name: '添加内容', exact: true })
              .evaluate((el) => document.activeElement === el),
            true,
          );
        }
      }
      await page.getByRole('button', { name: '添加内容', exact: true }).click();
      await page.getByTestId('message-disposition-trigger').click();
      await page.locator('[data-disposition-option="continue_current"]').click();
      assert.equal(await page.getByTestId('message-disposition-panel').count(), 0);
      assert.match(await page.getByTestId('message-disposition-trigger').innerText(), /接着当前工作/);
      await page.getByTestId('message-disposition-trigger').click();
      assert.equal(await page.locator('[data-disposition-scope]').count(), 0);
      assert.match(await page.getByTestId('message-disposition-panel').innerText(), /仅这一次/);
      assert.equal(
        await page.locator('[data-disposition-option="continue_current"]').getAttribute('aria-pressed'),
        'true',
      );
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'switch shell', exact: true }).click();
      await page.getByRole('button', { name: '添加内容', exact: true }).click();
      assert.equal(await page.getByRole('menuitem').first().getAttribute('data-testid'), 'message-disposition-trigger');
      assert.ok((await page.getByRole('dialog').getAttribute('class')).includes('--shell-paper'));
      await page.keyboard.press('Escape');
      assert.equal(await long.getAttribute('aria-expanded'), null);
      assert.deepEqual(errors, []);
      if (evidence) await writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(measurements, null, 2));
    } finally {
      await browser.close();
    }
  },
);
