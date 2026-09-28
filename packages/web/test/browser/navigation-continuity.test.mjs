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
    } else {
      reads.push(url.pathname + url.search);
      if (url.pathname === '/api/executions/active') {
        if (state.delayed) await executionGate.promise;
        const projectPath = url.searchParams.get('projectPath');
        body = {
          projectPath,
          executions:
            projectPath === '/fixture' && state.active
              ? [
                  {
                    executionId: 'run-a',
                    threadId: 'thread-a',
                    threadTitle: 'Still working',
                    catId: 'codex-astra',
                    kind: 'live_invocation',
                    startedAt: 1,
                    cancelability: {
                      state: 'cancelable',
                      target: {
                        kind: 'live_invocation',
                        threadId: 'thread-a',
                        catId: 'codex-astra',
                        executionId: 'run-a',
                      },
                    },
                  },
                ]
              : [],
        };
      }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(origin);
  await page.getByTestId('workspace-running-object').waitFor();
  await page.getByText('No scheduled tasks').waitFor();
  return { page, reads, writes, errors, state, executionGate, cancelGate };
}

test('same-project navigation keeps the real running view and pending action, with no All refetch', async () => {
  const proof = await openProof();
  const { page, reads, writes, errors, state, executionGate, cancelGate } = proof;
  try {
    await page.evaluate(() => {
      window.continuityBlankCount = 0;
      new MutationObserver(() => {
        if (!document.querySelector('[data-testid="workspace-running-object"]')) window.continuityBlankCount += 1;
      }).observe(document.querySelector('main'), { subtree: true, childList: true });
    });
    const cancelRequest = page.waitForRequest((request) => request.method() === 'POST');
    await page.getByTestId('workspace-running-object').locator('button').click();
    await cancelRequest;
    state.delayed = true;
    const refresh = page.waitForRequest((request) => request.url().includes('/executions/active'));
    await page.getByRole('button', { name: 'thread-b', exact: true }).click();
    await refresh;
    assert.equal(await page.getByTestId('workspace-running-object').count(), 1);
    assert.equal(await page.getByTestId('workspace-running-object').locator('button').isDisabled(), true);
    executionGate.release();
    for (let n = 0; n < 20; n++) {
      await page.getByRole('button', { name: n % 2 ? 'thread-b' : 'thread-a', exact: true }).click();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByTestId('workspace-running-object').count(), 1);
    }
    assert.equal(await page.evaluate(() => window.continuityBlankCount), 0);
    assert.equal(reads.filter((url) => url === '/api/schedule/tasks').length, 1);
    assert.equal(reads.filter((url) => url === '/api/schedule/control').length, 1);
    assert.deepEqual(writes, ['POST /api/threads/thread-a/executions/live/run-a/cancel']);
    assert.equal(state.documents, 1);
    assert.deepEqual(errors, []);
  } finally {
    executionGate.release();
    cancelGate.release();
    await page.close();
  }
});

test('changing project removes the departed running view before the new response arrives', async () => {
  const { page, errors, state, executionGate, cancelGate } = await openProof();
  try {
    state.delayed = true;
    const refresh = page.waitForRequest((request) => request.url().includes('projectPath=%2Fother'));
    await page.getByRole('button', { name: 'thread-other', exact: true }).click();
    await refresh;
    assert.equal(await page.getByTestId('workspace-running-object').count(), 0);
    await page.getByText('正在同步项目里的运行状态…', { exact: true }).waitFor();
    executionGate.release();
    await page.getByText('正在同步项目里的运行状态…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(state.documents, 1);
    assert.deepEqual(errors, []);
  } finally {
    executionGate.release();
    cancelGate.release();
    await page.close();
  }
});
