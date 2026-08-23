import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const summary = {
  invocationId: 'inv-cross',
  threadId: 'thread-canonical',
  sessionId: 'session-canonical',
  sessionSeq: 1,
  sessionStatus: 'sealed',
  catId: 'codex-sol',
  status: 'done',
  startedAt: 1_000,
  durationMs: 25,
  eventCount: 2,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 1,
  errorCount: 0,
  toolNames: [],
  keyMessages: ['canonical evidence'],
};

async function findFreePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert(address && typeof address !== 'string');
  socket.close();
  await once(socket, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const API_FIXTURES = new Map([
  ['/api/session', [{ userId: 'user-phase-c' }, 200]],
  [
    '/api/invocations/inv-cross/trajectory',
    [{ invocationId: 'inv-cross', threadId: 'thread-canonical', sessionId: 'session-canonical' }, 200],
  ],
  ['/api/invocations/inv-forbidden/trajectory', [{ code: 'INVOCATION_RECORD_ACCESS_DENIED' }, 403]],
  ['/api/invocations/inv-missing/trajectory', [{ code: 'INVOCATION_RECORD_NOT_FOUND' }, 404]],
  ['/api/threads/thread-canonical/invocations', [{ invocations: [summary], total: 1 }, 200]],
  [
    '/api/sessions/session-canonical/invocations/inv-cross',
    [
      {
        invocationId: 'inv-cross',
        total: 2,
        summary,
        events: [
          {
            v: 1,
            t: 1_000,
            threadId: 'thread-canonical',
            catId: 'codex-sol',
            sessionId: 'session-canonical',
            invocationId: 'inv-cross',
            eventNo: 0,
            event: { type: 'text', content: 'canonical evidence' },
          },
          {
            v: 1,
            t: 1_025,
            threadId: 'thread-canonical',
            catId: 'codex-sol',
            sessionId: 'session-canonical',
            invocationId: 'inv-cross',
            eventNo: 1,
            event: { type: 'done' },
          },
        ],
      },
      200,
    ],
  ],
  ['/api/debug/prompt-captures', [[{ captureId: 'capture-cross' }], 200]],
  ['/api/telemetry/traces', [{ spans: [{}] }, 200]],
  ['/api/recall/trajectories', [{ trajectories: [{}] }, 200]],
]);

let server;
let browser;
let baseUrl;

before(async () => {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  const port = await findFreePort();
  const output = [];
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: { ...process.env, NEXT_PUBLIC_API_URL: '', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/dev/f299-phase-c-evidence-preview`;
  await waitForPage(baseUrl, server, output);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopServer(server);
});

test('Hub evidence resolves canonically, exposes owner links, restores origin, and fails closed', async () => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const detailRequests = [];
  const apiRequests = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    apiRequests.push(`${route.request().method()} ${url.pathname}${url.search}`);
    const fixture = API_FIXTURES.get(url.pathname);
    if (fixture) {
      if (url.pathname === '/api/sessions/session-canonical/invocations/inv-cross') detailRequests.push(url.pathname);
      return json(route, fixture[0], fixture[1]);
    }
    if (url.pathname.includes('/api/threads/') && url.pathname.endsWith('/invocations')) {
      return json(route, { invocations: [], total: 0 });
    }
    return route.continue();
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const originCard = page.locator('[data-eval-event-id="verdict-f299-phase-c-preview"]');
    await page.getByText('机器原文与证据', { exact: true }).click();
    await page.getByRole('button', { name: /inv:inv-cross/ }).click();
    await page
      .getByTestId('invocation-trajectory-detail')
      .waitFor({ timeout: 10_000 })
      .catch(async () => {
        throw new Error(
          `trajectory detail did not render at ${page.url()}\nrequests:\n${apiRequests.join('\n')}\nbody:\n${(
            await page.locator('body').innerText()
          ).slice(0, 3_000)}`,
        );
      });
    assert.equal(new URL(page.url()).pathname, '/thread/thread-canonical');
    assert.equal(detailRequests.length, 1, 'detail must load only after canonical resolution');
    assert.deepEqual(await page.getByTestId('source-owned-evidence-link').allTextContents(), [
      'Prompt X-Ray',
      'Trace',
      'Task trajectory',
    ]);
    await page.getByRole('button', { name: '← 返回' }).click();
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.has('inv'));
    assert.equal(new URL(page.url()).pathname, '/thread/thread-origin');
    assert.equal(await originCard.evaluate((element) => document.activeElement === element), true);

    await page.getByRole('button', { name: /inv:inv-forbidden/ }).click();
    const denied = page.getByTestId('trajectory-resolution-error');
    await denied.waitFor();
    assert.equal(await denied.getAttribute('data-error-code'), 'INVOCATION_RECORD_ACCESS_DENIED');
    assert.match((await denied.textContent()) ?? '', /没有权限/);
    await denied.getByRole('button', { name: '返回来源' }).click();

    await page.getByRole('button', { name: /inv:inv-missing/ }).click();
    const missing = page.getByTestId('trajectory-resolution-error');
    await missing.waitFor();
    assert.equal(await missing.getAttribute('data-error-code'), 'INVOCATION_RECORD_NOT_FOUND');
    assert.match((await missing.textContent()) ?? '', /暂不可用/);
    assert.equal(detailRequests.length, 1, 'typed failures must never guess a session detail route');
  } finally {
    await page.close();
  }
});
