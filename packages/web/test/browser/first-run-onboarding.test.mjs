import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const evidence = process.env.CAT_CAFE_ONBOARDING_EVIDENCE_DIR;
let proofIndex = 0;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function waitForPage(url, server, output) {
  for (let i = 0; i < 180; i += 1) {
    if (server.exitCode !== null) throw new Error(`Next exited (${server.exitCode}): ${output.join('')}`);
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Wait for Next to compile the test route.
    }
    if (response?.ok) return;
    if (response?.status === 500)
      throw new Error(`Next returned 500: ${(await response.text()).slice(-6000)}\n${output.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${output.join('').slice(-4000)}`);
}

let server;
let browser;
let baseUrl;
let testEnvironment;
const serverOutput = [];

before(async () => {
  const port = await freePort();
  testEnvironment = await createNextDevTestEnvironment('onboarding', {
    API_SERVER_PORT: String(await freePort()),
    NEXT_PUBLIC_API_URL: '',
  });
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: testEnvironment.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  baseUrl = `http://127.0.0.1:${port}/dev/first-run-onboarding`;
  console.log(JSON.stringify({ url: baseUrl, serverPid: server.pid, startedAt: new Date().toISOString() }));
  await waitForPage(baseUrl, server, serverOutput);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exited;
    }
  }
  if (testEnvironment) {
    assert.equal(path.dirname(testEnvironment.distDirPath), WEB_ROOT);
    assert.match(path.basename(testEnvironment.distDirPath), /^\.next-test-onboarding-[A-Za-z0-9_-]+$/);
    assert.equal(path.dirname(testEnvironment.tsconfigPath), WEB_ROOT);
    assert.match(path.basename(testEnvironment.tsconfigPath), /^tsconfig\.next-test-onboarding-[A-Za-z0-9_-]+\.json$/);
    await testEnvironment.cleanup();
  }
});

function mockApi(route, runtimes, writes) {
  const request = route.request(),
    url = new URL(request.url());
  // The shared home shell registers its window capability when its test socket connects.
  // Admit only this bootstrap contract; every other POST remains in the no-write assertion.
  if (url.pathname === '/api/concierge/home/clients' && request.method() === 'POST') {
    const body = request.postDataJSON();
    assert.match(body.clientId, /^[0-9a-f-]{36}$/);
    assert.equal(body.socketId, 'onboarding-fixture');
    return route.fulfill({ json: { clientToken: body.clientId, expiresAt: Date.now() + 60000 } });
  }
  if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() });
  if (url.pathname === '/api/session') return route.fulfill({ json: { userId: 'onboarding-test' } });
  if (url.pathname === '/api/concierge/config') return route.fulfill({ json: { config: { enabled: false } } });
  if (url.pathname === '/api/concierge/thread') return route.fulfill({ json: { threadId: null } });
  if (url.pathname === '/api/concierge/desktop') return route.fulfill({ json: { connected: false } });
  // Home's shared shell reads this owner diagnostic before the wizard mounts.
  // Return its actual empty snapshot shape instead of a successful malformed {}.
  if (url.pathname === '/api/debug/callback-auth')
    return route.fulfill({
      json: {
        reasonCounts: {},
        toolCounts: {},
        byCat: {},
        recentSamples: [],
        totalFailures: 0,
        startedAt: 0,
        uptimeMs: 0,
        recent24h: { totalFailures: 0, byReason: {}, byTool: {}, byCat: {} },
      },
    });
  if (url.pathname === '/api/cats/native-runtimes') return route.fulfill({ json: { runtimes } });
  if (url.pathname === '/api/cats/runtime-models')
    return route.fulfill({
      json: {
        status: 'live',
        models: [{ value: 'model-test', label: 'Model test', efforts: [{ value: 'high', label: 'High' }] }],
      },
    });
  if (url.pathname === '/api/cat-templates')
    return route.fulfill({
      json: {
        templates: [
          {
            id: 'ragdoll',
            name: '布偶猫',
            nickname: '宪宪',
            avatar: '/avatars/opus.png',
            color: { primary: '#111111', secondary: '#eeeeee' },
            roleDescription: '一起做事',
            personality: '可靠',
          },
        ],
      },
    });
  if (request.method() === 'GET' && url.pathname === '/api/cats') return route.fulfill({ json: { cats: [] } });
  if (url.pathname === '/api/cats') {
    const body = request.postDataJSON();
    return route.fulfill({
      json: { cat: { id: body.catId, displayName: body.displayName, mentionPatterns: body.mentionPatterns } },
    });
  }
  if (url.pathname === '/api/threads') return route.fulfill({ json: { id: 'thread-1' } });
  return route.fulfill({ json: {} });
}

async function proof(runtimes, run) {
  const context = await browser.newContext(),
    page = await context.newPage(),
    writes = [],
    errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const sid = 'onboarding-fixture';
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
  await page.route('**/api/**', (route) => mockApi(route, runtimes, writes));
  const index = ++proofIndex;
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '重新检测', exact: true }).waitFor();
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: path.join(evidence, `${index}-setup.png`), fullPage: true });
    }
    await run({ page, writes });
    assert.deepEqual(errors, []);
    if (evidence) await page.screenshot({ path: path.join(evidence, `${index}-result.png`), fullPage: true });
  } catch (error) {
    console.error(
      JSON.stringify({
        url: page.url(),
        errors,
        writes,
        dom: (await page.locator('body').innerText()).slice(0, 12000),
      }),
    );
    throw error;
  } finally {
    await context.close();
  }
}

const codex = { id: 'codex', clientId: 'openai', label: 'Codex', installed: true, models: [] };
const claude = { id: 'claude', clientId: 'anthropic', label: 'Claude Code', installed: true, models: [] };
const dsh = {
  id: 'dsh',
  clientId: 'acp',
  label: 'DSH',
  installed: true,
  models: [],
  acp: { command: 'node', startupArgs: ['dsh.js', '--profile', 'acp'] },
};

test('recommends all three installed tools, skips the demo and creates ordinary chat with native defaults', async () => {
  await proof([codex, claude, dsh], async ({ page, writes }) => {
    for (const label of ['Codex', 'Claude Code', 'DSH'])
      assert.equal(await page.getByRole('checkbox', { name: `加入 ${label} 伙伴` }).isChecked(), true);
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: /下一步/ }).click();
    await page.getByLabel('你想完成什么？').fill('把我的阅读计划拆成三步');
    await page.getByRole('button', { name: '保存伙伴，前往对话' }).click();
    await page.getByText('已创建对话：thread-1').waitFor();
    const members = writes.filter((write) => write.path === '/api/cats').map((write) => write.body);
    assert.equal(members.length, 3);
    for (const member of members) {
      assert.equal(member.configurationSource, 'native_tool');
      assert.equal(member.defaultModel, '');
      assert.equal(member.accountRef, undefined);
    }
    assert.deepEqual(members[2].acp, { command: 'node', startupArgs: ['dsh.js', '--profile', 'acp'] });
    assert.equal(writes.find((write) => write.path === '/api/threads').body.bootcampState, undefined);
    const drafts = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cat-cafe:thread-drafts')));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0][0], 'thread-1');
    const lines = drafts[0][1].split('\n');
    assert.equal(lines[0], members.map((member) => member.mentionPatterns[0]).join(' '));
    assert.equal(lines[1], '把我的阅读计划拆成三步');
    assert.equal(lines.at(-1), '#execute');
    for (const [index, member] of members.entries())
      assert.ok(
        lines.some((line) => line.startsWith(`${index + 1}. ${member.displayName}（${member.mentionPatterns[0]}）`)),
      );
  });
});

test('zero detected tools does not create members, and re-detection can resume', async () => {
  const runtimes = [{ ...codex, installed: false }];
  await proof(runtimes, async ({ page, writes }) => {
    assert.equal(await page.getByRole('button', { name: /下一步/ }).isDisabled(), true);
    runtimes[0].installed = true;
    await page.getByRole('button', { name: '重新检测', exact: true }).click();
    await page.getByRole('checkbox', { name: '加入 Codex 伙伴' }).waitFor();
    await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked);
    assert.equal(writes.length, 0);
  });
});

test('return and reload retain the users selection and goal without writing', async () => {
  await proof([codex, claude, dsh], async ({ page, writes }) => {
    await page.getByRole('checkbox', { name: '加入 DSH 伙伴' }).uncheck();
    await page.getByRole('button', { name: /下一步/ }).click();
    await page.getByLabel('你想完成什么？').fill('保留我的小目标');
    await page.reload();
    await page.getByRole('button', { name: '重新检测', exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox', { name: '加入 DSH 伙伴' }).isChecked(), false);
    await page.getByRole('button', { name: /下一步/ }).click();
    assert.equal(await page.getByLabel('你想完成什么？').inputValue(), '保留我的小目标');
    assert.equal(writes.length, 0);
  });
});
