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
const PROMPT_CAPTURE_ID = '00000000-0000-0000-0000-000000000017';
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
const promptCapture = {
  captureId: PROMPT_CAPTURE_ID,
  invocationId: 'inv-cross',
  catId: 'codex-sol',
  model: 'gpt-5.6-sol',
  capturedAt: 1_000,
  systemPrompt: 'browser system contract',
  userPrompt: 'browser user contract',
  effectivePrompt: 'browser system contract\nbrowser user contract',
  injectionDecision: {
    isResume: false,
    canSkipOnResume: false,
    forceReinjection: false,
    injected: true,
  },
  promptBytes: 45,
  tokenEstimate: 12,
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
  ['/api/debug/prompt-captures', [[{ captureId: PROMPT_CAPTURE_ID }], 200]],
  [`/api/debug/prompt-captures/${PROMPT_CAPTURE_ID}`, [promptCapture, 200]],
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
  const promptDetailRequests = [];
  const rejectedWebPromptDetailRequests = [];
  const apiRequests = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    apiRequests.push(`${route.request().method()} ${url.pathname}${url.search}`);
    if (url.pathname === `/api/debug/prompt-captures/${PROMPT_CAPTURE_ID}`) {
      if (url.origin === new URL(baseUrl).origin) {
        rejectedWebPromptDetailRequests.push(route.request().url());
        return json(route, { error: 'Forbidden' }, 403);
      }
      promptDetailRequests.push(route.request().url());
    }
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
      'Legacy Prompt X-Ray',
      'Trace',
      'Task trajectory',
    ]);
    const promptChip = page.getByTestId('source-owned-evidence-link').filter({ hasText: 'Prompt X-Ray' });
    const trajectoryUrl = page.url();
    await promptChip.click();
    await page
      .getByTestId('prompt-capture-inspector')
      .waitFor({ timeout: 5_000 })
      .catch(async () => {
        throw new Error(
          `Prompt Inspector did not open at ${page.url()}\ndirect detail: ${promptDetailRequests.join(', ') || 'none'}\nWeb detail rejected: ${rejectedWebPromptDetailRequests.join(', ') || 'none'}\nbody: ${(await page.locator('body').innerText()).slice(0, 1_000)}`,
        );
      });
    assert.equal(await promptChip.evaluate((element) => element.tagName), 'BUTTON');
    assert.equal(
      page.url(),
      trajectoryUrl,
      'Prompt X-Ray must stay in the first-party viewer instead of raw navigation',
    );
    assert.match((await page.getByTestId('prompt-capture-inspector').textContent()) ?? '', /browser system contract/);
    assert.equal(promptDetailRequests.length, 1, 'readability probe should fetch prompt detail exactly once');
    assert.equal(
      rejectedWebPromptDetailRequests.length,
      0,
      'click must never fall through the Web origin to the privileged raw detail route',
    );
    const webUrl = new URL(baseUrl);
    const expectedApiOrigin = `${webUrl.protocol}//${webUrl.hostname}:${Number(webUrl.port) + 1}`;
    assert.equal(
      new URL(promptDetailRequests[0]).origin,
      expectedApiOrigin,
      'prompt detail must use API_URL direct transport',
    );
    assert.notEqual(
      new URL(promptDetailRequests[0]).origin,
      webUrl.origin,
      'prompt detail must not navigate through the Web relative/proxy origin',
    );
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
