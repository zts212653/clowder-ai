/**
 * Real Chromium proof for the generic Host thread-picker renderer.
 *
 * The page is built from the production renderer and the real Sidebar projection modules;
 * Fastify serves only the synthetic operation's list/choose and attention-config responses.
 * No plugin runtime, real owner data, or paid model is involved.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { build } from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = fileURLToPath(new URL('../../../../artifacts/thread-picker-browser/', import.meta.url));
const require = createRequire(path.join(webRoot, 'package.json'));
const tailwind = require('tailwindcss');
const tailwindConfig = require(path.join(webRoot, 'tailwind.config.js'));

test('generic thread-picker renders real groups, keeps order, and saves the draft', { timeout: 120000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const attention = {
    aliases: {},
    memberSort: {},
    groups: [{ id: 'group-1', name: '客户跟进', threadIds: ['t1', 't2'] }],
    open: {},
    collapsedPeek: {},
    recentGroupIds: [],
  };
  let received;
  const app = Fastify();
  app.get('/', async (_request, reply) =>
    reply
      .type('text/html')
      .send(
        '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/proof.css"></head><body><div id="root"></div><script type="module" src="/proof.js"></script></body></html>',
      ),
  );
  app.get('/proof.js', async (_request, reply) => reply.type('text/javascript').send(script));
  app.get('/proof.css', async (_request, reply) => reply.type('text/css').send(css));
  app.get('/api/session', async () => ({ userId: 'owner-user', csrfToken: 'browser-fixture' }));
  app.get('/api/config/thread-attention', async () => attention);
  app.get('/api/plugins/fixture/actions/threads/list', async () => ({
    ok: true,
    render: 'thread-picker',
    data: { selected: ['t2'], excluded: [] },
  }));
  app.post('/api/plugins/fixture/actions/threads/list', async () => ({
    ok: true,
    render: 'thread-picker',
    data: { selected: ['t2'], excluded: [] },
  }));
  app.post('/api/plugins/fixture/actions/threads/choose', async (request) => {
    received = request.body;
    return { ok: true, render: 'thread-picker', data: { selected: received.ids, excluded: [] } };
  });

  let script = '';
  let css = '';
  let browser;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const built = await build({
      root: webRoot,
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      css: {
        postcss: {
          plugins: [
            tailwind({
              ...tailwindConfig,
              content: [
                path.join(webRoot, 'src/**/*.{ts,tsx}'),
                path.join(webRoot, 'test/browser/fixtures/thread-picker.tsx'),
              ],
            }),
          ],
        },
      },
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: { 'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(app.listeningOrigin) },
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: path.join(webRoot, 'test/browser/fixtures/thread-picker.tsx'),
          output: { format: 'es', inlineDynamicImports: true },
        },
      },
    });
    const output = built.output;
    script = output.find((item) => item.type === 'chunk' && item.isEntry)?.code ?? '';
    css = output
      .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
      .map((item) => item.source)
      .join('\n');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.listeningOrigin, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByTestId('thread-picker-summary').waitFor({ timeout: 10000 });
    assert.match((await page.getByTestId('thread-picker-summary').textContent()) ?? '', /已选 1 个/);
    await page.screenshot({ path: path.join(evidence, 'light.png'), fullPage: true });

    await page.getByTestId('thread-picker-open').click();
    await page.getByTestId('thread-picker-dialog').waitFor();
    assert.equal(await page.getByText('客户跟进', { exact: true }).count(), 1);
    const order = await page
      .locator('[data-testid^="thread-picker-row-"]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid')));
    assert.deepEqual(order, ['thread-picker-row-t1', 'thread-picker-row-t2']);
    assert.equal(await page.getByTestId('thread-picker-row-t3').count(), 0);
    await page.screenshot({ path: path.join(evidence, 'dialog-light.png'), fullPage: true });

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: path.join(evidence, 'dialog-dark.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, 'dialog-390.png'), fullPage: true });

    await page.getByTestId('thread-picker-check-t1').check();
    assert.match((await page.getByTestId('thread-picker-count').textContent()) ?? '', /已选 2 个/);
    assert.deepEqual(
      await page
        .locator('[data-testid^="thread-picker-row-"]')
        .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid'))),
      ['thread-picker-row-t1', 'thread-picker-row-t2'],
    );
    await page.getByTestId('thread-picker-save').click();
    await page.getByTestId('thread-picker-dialog').waitFor({ state: 'detached' });
    assert.equal(received?.selection, 'threads');
    assert.deepEqual(new Set(received?.ids), new Set(['t1', 't2']));
    assert.match((await page.getByTestId('thread-picker-summary').textContent()) ?? '', /已选 2 个/);
    await page.screenshot({ path: path.join(evidence, 'after-save.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(evidence, 'result.json'),
      JSON.stringify(
        {
          kind: 'host-thread-picker-browser',
          viewport: ['1200x900', '390x844'],
          themes: ['light', 'dark'],
          verified: ['real-groups', 'pinned-order', 'check-does-not-reorder', 'save-whole-draft', '390-no-overflow'],
          notVerified: ['real-plugin-operation', 'real-owner-data', 'macOS'],
        },
        null,
        2,
      ),
    );
    console.log(`thread-picker browser evidence: ${evidence}`);
  } finally {
    await browser?.close();
    await app.close();
  }
});
