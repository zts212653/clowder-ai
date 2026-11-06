import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://issue1881.test';

test('continuous polling honors close, recovery, a new outage and message input', { timeout: 60_000 }, async (t) => {
  const result = await build({
    root: webRoot,
    configFile: false,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@': path.join(webRoot, 'src') } },
    define: {
      'process.env.NEXT_PUBLIC_API_URL': JSON.stringify(origin),
      'process.env.NODE_ENV': JSON.stringify('test'),
    },
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: path.join(webRoot, 'test/browser/fixtures/issue1881-connection-notice.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((entry) => entry.output) : result.output;
  const bundle = outputs.find((entry) => entry.type === 'chunk' && entry.isEntry);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  let offline = true;
  await page.route(`${origin}/**`, (route) => {
    if (route.request().url().includes('/api/')) {
      return offline ? route.abort('connectionrefused') : route.fulfill({ json: {} });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto(origin);
  await Promise.all(
    outputs
      .filter((entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'))
      .map((entry) => page.addStyleTag({ content: String(entry.source) })),
  );
  await page.addScriptTag({ type: 'module', content: bundle.code });
  const notices = page.getByRole('alert');
  await notices.waitFor();
  await page.clock.runFor(60_000);
  assert.equal(await notices.count(), 1);
  const evidence = process.env.ISSUE1881_EVIDENCE_DIR;
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'browser-outage.png') });
  }
  await page.getByRole('button', { name: '关闭“后端连接异常”通知', exact: true }).click();
  await page.clock.runFor(60_000);
  assert.equal(await notices.count(), 0, 'closing a notice suppresses further polling reminders in the same outage');
  await page.getByLabel('Message').click();
  await page.keyboard.type('Input remains usable');
  assert.equal(await page.getByLabel('Message').inputValue(), 'Input remains usable');

  offline = false;
  await page.clock.runFor(6_000);
  await page.getByRole('status').getByText('connected', { exact: true }).waitFor();
  offline = true;
  await page.clock.runFor(6_000);
  await page.getByRole('status').getByText('offline', { exact: true }).waitFor();
  await notices.waitFor();
  assert.equal(await notices.count(), 1, 'a new outage can notify again after a successful recovery');
  offline = false;
  await page.clock.runFor(6_000);
  await page.getByRole('status').getByText('connected', { exact: true }).waitFor();
  assert.equal(await notices.count(), 0, 'successful polling clears the connection notice');
  assert.deepEqual(errors, []);
  if (evidence) {
    await page.screenshot({ path: path.join(evidence, 'browser-recovered.png') });
  }
});
