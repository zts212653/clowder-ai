import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let browser;
let server;
let environment;
let url = process.env.ISSUE1371_PREVIEW_URL;
before(async () => {
  if (!url) {
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    probe.close();
    await once(probe, 'close');
    environment = await createNextDevTestEnvironment('issue1371-adopted-hold', {
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:5127',
    });
    server = spawn(
      process.execPath,
      [path.resolve(webRoot, '../../node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)],
      { cwd: webRoot, env: environment.env, stdio: 'ignore' },
    );
    url = `http://127.0.0.1:${port}/dev/issue1371-adopted-hold`;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error('fixture server exited before readiness');
      try {
        if ((await fetch(url)).ok) break;
      } catch {
        /* first compile */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal((await fetch(url)).status, 200);
  }
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
  }
  await environment?.cleanup();
});

test(
  '#1371 failed wake is visible on desktop/mobile and never retries from rendering',
  { timeout: 60000 },
  async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const writes = [];
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/debug/callback-auth') {
        await route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' });
        return;
      }
      if (request.method() !== 'GET' && pathname !== '/api/auth/session')
        writes.push(`${request.method()} ${pathname}`);
      const body = pathname.endsWith('/queue')
        ? { queue: [], paused: false }
        : pathname === '/api/cats'
          ? { cats: [] }
          : { ok: true, userId: 'preview-owner' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.locator('main[data-ready="true"]').waitFor();
      const text = await page.locator('main').innerText();
      assert.match(text, /检查已通过，通知尚未结算/);
      assert.doesNotMatch(text, /routine internal control/);
      assert.equal(await page.locator('[data-queue-target-row="codex-astra"]').count(), 1);
      assert.match(text, /队列已暂停\s*1/);
      for (const [width, theme] of [
        [1100, 'light'],
        [360, 'light'],
        [360, 'dark'],
      ]) {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (process.env.ISSUE1371_EVIDENCE_DIR) {
          await mkdir(process.env.ISSUE1371_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, `${width}-${theme}.png`),
            fullPage: true,
          });
        }
      }
      assert.deepEqual(writes, [], 'rendering a failed notification cannot start work or consume it');
      await page.getByRole('button', { name: '停止后续处理', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-queue-target-row="codex-astra"]'));
      assert.deepEqual(writes, ['DELETE /api/threads/issue1371-preview/queue/adopted-hold-preview']);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  },
);

test('a missed completion recovers three stale receipts without a reconnect, click or mutation', async () => {
  const origin = 'https://queue-reconcile.test';
  const threadId = 'issue1371-queue-reconcile';
  const queue = [1, 2, 3].map((index) => ({
    id: `stale-${index}`,
    threadId,
    userId: 'preview-owner',
    messageId: `message-${index}`,
    mergedMessageIds: [],
    content: `已处理的讨论消息 ${index}`,
    source: 'agent',
    sourceCategory: 'a2a',
    targetCats: ['codex-astra'],
    targetStates: { 'codex-astra': 'seen' },
    intent: 'execute',
    autoExecute: true,
    status: 'queued',
    createdAt: 1200,
    queueReceipt: {
      version: 1,
      entryId: `stale-${index}`,
      reminderAttempts: [],
      targets: [{ catId: 'codex-astra', state: 'seen', invocationId: 'ended-child', seenAt: 1300 }],
    },
  }));
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
        input: path.join(webRoot, 'test/browser/fixtures/issue1371-queue-reconcile.tsx'),
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const writes = [];
  const errors = [];
  let queueReads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const request = route.request();
    const parsed = new URL(request.url());
    assert.equal(parsed.origin, origin, 'browser attempted to leave the isolated fixture origin');
    if (request.method() !== 'GET' && parsed.pathname !== '/api/auth/session') writes.push(request.method());
    if (parsed.pathname === '/proof.js') {
      await route.fulfill({ contentType: 'text/javascript', body: bundle.code });
    } else if (parsed.pathname === '/proof.css') {
      await route.fulfill({ contentType: 'text/css', body: css });
    } else if (parsed.pathname.startsWith('/socket.io/')) {
      await route.abort();
    } else if (parsed.pathname.startsWith('/api/')) {
      if (parsed.pathname.endsWith('/queue')) queueReads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          parsed.pathname.endsWith('/queue')
            ? { queue: [], paused: false, activeInvocations: [] }
            : { ok: true, userId: 'preview-owner', cats: [], threads: [] },
        ),
      });
    } else {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/proof.css">
        <div id="root"></div><script id="queue-seed" type="application/json">${JSON.stringify(queue)}</script>
        <script type="module" src="/proof.js"></script>`,
      });
    }
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('main[data-ready="true"]').waitFor();
    assert.equal(await page.locator('[data-queue-target-row="codex-astra"]').count(), 3);
    assert.match(await page.locator('main').innerText(), /已读，但关联回合已结束/);
    assert.match(await page.locator('main').innerText(), /已处理的讨论消息 1/);
    if (process.env.ISSUE1371_EVIDENCE_DIR) {
      await mkdir(process.env.ISSUE1371_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, 'queue-before.png') });
    }
    await page.clock.fastForward(31_000);
    await page.locator('[data-queue-target-row="codex-astra"]').first().waitFor({ state: 'detached' });
    assert.equal(queueReads, 1);
    assert.equal(await page.locator('[data-testid="queue-recover"]').count(), 0);
    assert.deepEqual(writes, [], 'read-side reconciliation must not retry or settle a source');
    assert.deepEqual(errors, []);
    if (process.env.ISSUE1371_EVIDENCE_DIR) {
      await page.screenshot({ path: path.join(process.env.ISSUE1371_EVIDENCE_DIR, 'queue-after.png') });
    }
  } finally {
    await page.close();
  }
});
