import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { openFirstRunEntryApi } from '../fixtures/first-run-entry-api.mjs';
import { cats, createChatProofApi } from './fixtures/f322-chat-real-page-data.mjs';

// Actual production UI and entry/guide/draft handlers with atomic preference files.
// Other HTTP reads, the Socket.IO wire and authenticated session identity remain explicit fixtures;
// in-memory guide threads are NOT installed/Redis/authentication acceptance.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(webRoot, '../..');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const evidence = process.env.CAT_CAFE_ENTRY_EVIDENCE_DIR ?? path.join(repo, '.tmp', `first-entry-${Date.now()}`);
const output = [],
  receipts = [];
let server, browser, baseUrl;

async function freePort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  listener.close();
  await once(listener, 'close');
  return port;
}

before(async () => {
  assert.equal(
    (await readFile(path.join(webRoot, '.next/.build-commit'), 'utf8')).trim(),
    revision,
    'rebuild production UI from current HEAD first',
  );
  await mkdir(evidence, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [path.join(webRoot, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)],
    {
      cwd: webRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        API_SERVER_PORT: String(await freePort()),
        FRONTEND_PORT: String(port),
        REDIS_URL: 'redis://127.0.0.1:1',
      },
    },
  );
  server.stdout.on('data', (value) => output.push(String(value)));
  server.stderr.on('data', (value) => output.push(String(value)));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(server.exitCode, null, output.join(''));
    if (
      await fetch(baseUrl, { signal: AbortSignal.timeout(500) })
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, 'production server became ready');
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.exitCode === null && !server.signalCode) {
    const closed = once(server, 'exit');
    server.kill();
    await closed;
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify(
      {
        revision,
        httpFixture: true,
        entryAndGuideRoutes: 'production handlers with real atomic preference files; test session identity',
        modelCalls: 0,
        frontend: baseUrl,
        serverPid: server?.pid,
        serverExitCode: server?.exitCode,
        serverSignal: server?.signalCode,
        receipts,
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(evidence, 'server.log'), output.join(''));
});

async function fixture(shell, scenario) {
  const entryApi = await openFirstRunEntryApi(path.join(evidence, `${shell}-${scenario}-api`), 'owner-proof');
  assert.equal(
    (
      await entryApi.request('/api/config/onboarding/entry', {
        method: 'PUT',
        body: JSON.stringify({ status: 'pending' }),
      })
    ).statusCode,
    200,
  );
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((selected) => {
    localStorage.setItem('cat-cafe:shell-presentation', selected);
    localStorage.setItem('cat-cafe:pinned-settings-sections', '[]');
  }, shell);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const state = {
    shell,
    scenario,
    status: 'pending',
    errors: [],
    consoleErrors: [],
    unexpected: [],
    writes: [],
    passed: false,
  };
  receipts.push(state);
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  // Match the existing F322 wire fixture. Never connect this page to an unrelated
  // port, and keep console errors strict rather than filtering connection errors.
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const sid = `entry-${shell}-${scenario}`;
    socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 300000, pingTimeout: 200000 })}`);
    socket.onMessage((packet) => {
      const text = String(packet);
      if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
      if (!text.startsWith('42')) return;
      const bracket = text.indexOf('['),
        ack = text.slice(2, bracket);
      const [event, room] = JSON.parse(text.slice(bracket));
      if (event === 'join_room' && ack) socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
    });
  });
  const common = createChatProofApi(Date.now(), false, true);
  const bodies = {
    '/api/debug/callback-auth': {
      reasonCounts: {},
      toolCounts: {},
      byCat: {},
      recentSamples: [],
      totalFailures: 0,
      startedAt: 0,
      uptimeMs: 0,
      recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
    },
    '/api/threads/default': { id: 'default', title: '默认对话', participants: [], createdAt: Date.now() },
    '/api/threads/default/game': { game: null },
    '/api/threads/default/active-pane': { active: false },
    '/api/bootcamp/threads': { threads: [] },
    '/api/concierge/desktop': { connected: false },
    '/api/concierge/config': { enabled: false },
    '/api/concierge/thread': { thread: null },
    '/api/threads/default/read/latest': { ok: true },
    '/api/entrusted-work/needs-me': { ownerReads: [] },
    '/api/approval-hub/pending': { items: [], count: 0 },
    '/api/artifacts': { view: 'works', artifacts: [], total: 0, complete: true, workLineage: 'resolved' },
    '/api/projects/cwd': { path: '/author-entry-fixture' },
    '/api/executions/active': { scope: 'all', executions: [], unavailableProjectPaths: [] },
  };
  const homeLeases = new Map();
  await context.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      method = req.method();
    const reply = (json, status = 200) => route.fulfill({ status, json });
    switch (url.pathname) {
      case '/api/concierge/home/clients': {
        assert.equal(method, 'POST');
        const { clientId } = req.postDataJSON();
        const clientToken = '00000000-0000-4000-8000-000000000001';
        homeLeases.set(clientId, clientToken);
        return reply({ clientToken, expiresAt: Date.now() + 60000 });
      }
      case '/api/config/onboarding/entry':
        if (method === 'PUT') {
          state.writes.push(`entry:${req.postDataJSON().status}`);
        }
        {
          const response = await entryApi.request(url.pathname, { method, body: req.postData() });
          state.status = response.json().status;
          return reply(response.json(), response.statusCode);
        }
      case '/api/config/onboarding':
        return reply({ userId: 'owner-proof', version: 'collaboration-v1', status: 'completed' });
      case '/api/cats':
        assert.equal(method, 'GET');
        return reply({ cats: [cats[0]] });
      case '/api/guide-flows/first-run-entry': {
        const response = await entryApi.request(url.pathname);
        return reply(response.json(), response.statusCode);
      }
      case '/api/routing/preview':
        return reply({ targetCats: [cats[0].id], reason: { kind: 'recent_replier' } });
      case '/api/threads/default/composer-draft': {
        // Autosave can race a reload; preserve the real HTTP 409 revision fence.
        const response = await entryApi.request(url.pathname, { method, body: req.postData() });
        return reply(response.json(), response.statusCode);
      }
    }
    if (url.pathname.startsWith('/api/concierge/home/clients/')) {
      assert.equal(method, 'DELETE');
      const clientId = url.pathname.split('/').at(-1);
      assert.equal(req.postDataJSON().clientToken, homeLeases.get(clientId));
      return reply({ released: homeLeases.delete(clientId) });
    }
    if (url.pathname.startsWith('/api/guide-actions/')) {
      state.writes.push(url.pathname);
      const response = await entryApi.request(url.pathname, { method, body: req.postData() });
      return reply(response.json(), response.statusCode);
    }
    if (Object.hasOwn(bodies, url.pathname)) return reply(bodies[url.pathname]);
    const response = common.respond(req, url);
    if (response) return route.fulfill(response);
    state.unexpected.push(`${method} ${url.pathname}`);
    return reply({ error: 'Unexpected first-entry fixture request' }, 500);
  });
  return { page, context, state, common, entryApi };
}

for (const shell of ['classic', 'v2'])
  for (const action of ['complete', 'dismiss']) {
    test(`${shell}: unpinned settings remain usable; ${action} persists across reload`, async () => {
      const { page, context, state, common, entryApi } = await fixture(shell, action);
      try {
        await page.goto(`${baseUrl}/?shell=${shell}&lang=zh`, { waitUntil: 'domcontentloaded' });
        const panel = page.getByRole('dialog', { name: '引导面板' });
        await panel.waitFor();
        await page.waitForFunction(() => {
          const node = document.querySelector('[aria-label="引导面板"]');
          return node && getComputedStyle(node).opacity === '1';
        });
        assert.equal(await page.locator('[data-guide-id="hub.trigger"]:visible').count(), 1);
        assert.match(await panel.innerText(), /成员/);
        assert.match(await panel.innerText(), /密钥|账号/);
        const input = page.locator('textarea:visible').first();
        await input.fill('提醒期间也可以开始自己的任务');
        assert.equal(await input.inputValue(), '提醒期间也可以开始自己的任务');
        await page.screenshot({ path: path.join(evidence, `${shell}-${action}-visible.png`), fullPage: true });
        const saved = page.waitForResponse(
          (res) => res.url().includes('/api/config/onboarding/entry') && res.request().method() === 'PUT',
        );
        if (action === 'complete') {
          await panel.getByRole('button', { name: '完成引导', exact: true }).click();
          await page.waitForFunction(() =>
            [...document.querySelectorAll('button')].some((node) => node.textContent === '知道了' && !node.disabled),
          );
          await saved;
          assert.equal(state.status, 'completed');
          await page.getByRole('button', { name: '知道了', exact: true }).click();
        } else {
          await panel.getByRole('button', { name: '退出引导' }).click();
          await saved;
          assert.equal(state.status, 'dismissed');
        }
        const readReceipt = page.waitForResponse(
          (res) => res.url().includes('/api/config/onboarding/entry') && res.request().method() === 'GET',
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await (await readReceipt).finished();
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.locator('textarea:visible').first().waitFor();
        assert.equal(await panel.count(), 0);
        assert.equal(state.status, action === 'complete' ? 'completed' : 'dismissed');
        assert.equal(state.writes.filter((value) => value.startsWith('entry:')).length, 1);
        assert.equal(
          state.writes.some((value) => value.startsWith('/api/guide-actions/')),
          false,
        );
        assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:pinned-settings-sections')), '[]');
        assert.equal(await page.evaluate(() => localStorage.getItem('cat-cafe:shell-presentation')), shell);
        assert.deepEqual(state.errors, []);
        assert.deepEqual(state.consoleErrors, []);
        assert.deepEqual(state.unexpected, []);
        assert.deepEqual(common.sent, [], 'no real task was submitted');
        state.passed = true;
      } catch (error) {
        await page.screenshot({ path: path.join(evidence, `${shell}-${action}-failed.png`), fullPage: true });
        state.failure = error.message;
        throw error;
      } finally {
        await entryApi.app.close();
        await context.close();
      }
    });
  }
