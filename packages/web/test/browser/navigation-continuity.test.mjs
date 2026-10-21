import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const origin = 'https://navigation-continuity.test';
let browser;
let bundle;

before(async () => {
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
        input: path.join(webRoot, 'test/browser/fixtures/navigation-continuity.tsx'),
        output: { format: 'es', inlineDynamicImports: true },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  bundle = outputs.find((item) => item.type === 'chunk' && item.isEntry);
  assert(bundle?.type === 'chunk');
  browser = await chromium.launch({ headless: true });
});
after(async () => browser?.close());

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const executions = [
  { executionId: 'run-a', threadId: 'thread-a', threadTitle: 'Still working', projectPath: '/fixture' },
  {
    executionId: 'run-other',
    threadId: 'thread-other',
    threadTitle: 'Working in another project',
    projectPath: '/other',
  },
].map((execution) => ({
  ...execution,
  catId: 'codex-astra',
  kind: 'live_invocation',
  startedAt: 1,
  cancelability: {
    state: 'cancelable',
    target: {
      kind: 'live_invocation',
      threadId: execution.threadId,
      catId: 'codex-astra',
      executionId: execution.executionId,
    },
  },
}));

function assertGlobalReads(reads) {
  const executionReads = reads.filter((url) => url.startsWith('/api/executions/active'));
  assert.ok(executionReads.length > 0);
  assert.ok(
    executionReads.every((url) => url === '/api/executions/active?scope=all'),
    executionReads.join('\n'),
  );
}

async function openProof() {
  const page = await browser.newPage();
  const reads = [],
    writes = [],
    errors = [];
  const executionGate = gate(),
    cancelGate = gate();
  const state = { delayed: false, active: true, documents: 0 };
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    assert.equal(url.origin, origin, 'the fixture must not contact a live service');
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.code });
    if (!url.pathname.startsWith('/api/')) {
      state.documents += 1;
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
    }
    let body = { cats: [], tasks: [], global: null };
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${url.pathname}`);
      await cancelGate.promise;
      if (url.pathname === '/api/threads/thread-a/executions/live/run-a/cancel') state.active = false;
    } else {
      reads.push(url.pathname + url.search);
      if (url.pathname === '/api/executions/active') {
        if (state.delayed) await executionGate.promise;
        body = {
          scope: 'all',
          executions: executions.filter((run) => state.active || run.executionId !== 'run-a'),
        };
      }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(origin);
  await page.getByTestId('workspace-running-object').filter({ hasText: 'Still working' }).waitFor();
  await page.getByTestId('workspace-running-object').filter({ hasText: 'Working in another project' }).waitFor();
  await page.getByText('No scheduled tasks').waitFor();
  assertGlobalReads(reads);
  return { page, reads, writes, errors, state, executionGate, cancelGate };
}

test('same-project navigation keeps all running views and pending action without schedule refetches', async () => {
  const proof = await openProof();
  const { page, reads, writes, errors, state, executionGate, cancelGate } = proof;
  try {
    await page.evaluate(() => {
      window.continuityBlankCount = 0;
      new MutationObserver(() => {
        if (document.querySelectorAll('[data-testid="workspace-running-object"]').length !== 2)
          window.continuityBlankCount += 1;
      }).observe(document.querySelector('main'), { subtree: true, childList: true });
    });
    const cancelRequest = page.waitForRequest((request) => request.method() === 'POST');
    const selected = page.getByTestId('workspace-running-object').filter({ hasText: 'Still working' });
    const other = page.getByTestId('workspace-running-object').filter({ hasText: 'Working in another project' });
    await selected.locator('button').click();
    await cancelRequest;
    state.delayed = true;
    const refresh = page.waitForRequest((request) => request.url().includes('/executions/active'));
    await page.getByRole('button', { name: 'thread-b', exact: true }).click();
    await refresh;
    assert.equal(await page.getByTestId('workspace-running-object').count(), 2);
    assert.equal(await selected.locator('button').isDisabled(), true);
    assert.equal(await other.locator('button').isDisabled(), false);
    executionGate.release();
    for (let n = 0; n < 20; n++) {
      await page.getByRole('button', { name: n % 2 ? 'thread-b' : 'thread-a', exact: true }).click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByTestId('workspace-running-object').count(), 2);
    }
    assert.equal(await page.evaluate(() => window.continuityBlankCount), 0);
    assert.equal(reads.filter((url) => url === '/api/schedule/tasks').length, 1);
    assert.equal(reads.filter((url) => url === '/api/schedule/control').length, 1);
    assert.deepEqual(writes, ['POST /api/threads/thread-a/executions/live/run-a/cancel']);
    assertGlobalReads(reads);
    assert.equal(state.documents, 1);
    assert.deepEqual(errors, []);
  } finally {
    executionGate.release();
    cancelGate.release();
    await page.close();
  }
});

test('changing project retains global work and the exact pending cancellation through the new response', async () => {
  const { page, reads, writes, errors, state, executionGate, cancelGate } = await openProof();
  try {
    const selected = page.getByTestId('workspace-running-object').filter({ hasText: 'Still working' });
    const other = page.getByTestId('workspace-running-object').filter({ hasText: 'Working in another project' });
    const cancelRequest = page.waitForRequest((request) => request.method() === 'POST');
    await selected.locator('button').click();
    await cancelRequest;
    state.delayed = true;
    const refresh = page.waitForRequest((request) => request.url().endsWith('/executions/active?scope=all'));
    await page.getByRole('button', { name: 'thread-other', exact: true }).click();
    await refresh;
    assert.equal(await page.locator('main').getAttribute('data-thread'), 'thread-other');
    assert.equal(await page.getByTestId('workspace-running-object').count(), 2);
    assert.equal(await selected.locator('button').isDisabled(), true);
    assert.equal(await other.locator('button').isDisabled(), false);
    assert.deepEqual(
      await page.getByTestId('workspace-running-project').evaluateAll((rows) => rows.map((row) => row.title).sort()),
      ['/fixture', '/other'],
    );
    assert.equal(await page.getByText('正在同步所有对话的运行状态…', { exact: true }).count(), 0);
    const refreshed = page.waitForResponse((response) => response.url().endsWith('/executions/active?scope=all'));
    executionGate.release();
    await refreshed;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByTestId('workspace-running-object').count(), 2);
    assert.equal(await selected.locator('button').isDisabled(), true);
    const afterCancel = page.waitForResponse((response) => response.url().endsWith('/executions/active?scope=all'));
    cancelGate.release();
    assert.deepEqual(
      (await (await afterCancel).json()).executions.map((run) => run.executionId),
      ['run-other'],
    );
    await selected.waitFor({ state: 'hidden' });
    assert.equal(await other.count(), 1);
    assert.equal(await other.locator('button').isDisabled(), false);
    assert.deepEqual(writes, ['POST /api/threads/thread-a/executions/live/run-a/cancel']);
    assertGlobalReads(reads);
    assert.equal(state.documents, 1);
    assert.deepEqual(errors, []);
  } finally {
    executionGate.release();
    cancelGate.release();
    await page.close();
  }
});
