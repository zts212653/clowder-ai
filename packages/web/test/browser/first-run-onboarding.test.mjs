import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');

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
  testEnvironment = await createNextDevTestEnvironment('onboarding');
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

function mockApi(route, clients, writes, accounts = []) {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() });
  if (url.pathname === '/api/debug/callback-auth') {
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
  }
  if (request.method() === 'GET' && url.pathname === '/api/threads') return route.fulfill({ json: { threads: [] } });
  if (url.pathname === '/api/first-run/available-clients') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ clients }) });
  }
  if (url.pathname === '/api/accounts') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ providers: accounts }) });
  }
  if (url.pathname === '/api/cat-templates') {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        templates: [
          {
            id: 'planner',
            name: 'Planner',
            nickname: 'Planner',
            avatar: 'cat',
            color: { primary: '#111', secondary: '#eee' },
            roleDescription: 'Break goals into steps',
            personality: 'Clear',
            teamStrengths: 'Planning',
          },
        ],
        clientDefaults: {
          codex: { defaultModel: 'gpt-test', models: ['gpt-test'] },
          claude: { defaultModel: 'claude-test', models: ['claude-test'] },
        },
      }),
    });
  }
  if (url.pathname === '/api/first-run/connectivity-test') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, message: '连接成功' }) });
  }
  if (request.method() === 'GET' && url.pathname === '/api/cats') return route.fulfill({ json: { cats: [] } });
  if (url.pathname === '/api/cats' || url.pathname === '/api/threads') {
    const body = request.postDataJSON();
    return route.fulfill({
      json:
        url.pathname === '/api/cats' ? { cat: { id: body.catId, displayName: body.displayName } } : { id: 'thread-1' },
    });
  }
  return route.fulfill({ json: {} });
}

async function openPage(clients, accounts = []) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const writes = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push((error.stack ?? error.message).split('\n').slice(0, 5).join('\n')));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/**', (route) => mockApi(route, clients, writes, accounts));
  return { context, page, writes, errors };
}

async function configure(page) {
  for (let i = 0; i < 3; i += 1) await page.getByTestId('first-run-demo-advance').click();
  await page.getByRole('button', { name: /Planner/ }).click();
}

async function proof(clients, run, accounts = []) {
  const fixture = await openPage(clients, accounts);
  try {
    await fixture.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await fixture.page.getByTestId('first-run-demo-advance').waitFor();
    await fixture.page.getByTestId('first-run-demo-advance').click();
    await run(fixture);
    assert.deepEqual(fixture.errors, []);
  } catch (error) {
    console.error(
      JSON.stringify({
        url: fixture.page.url(),
        errors: fixture.errors,
        dom: (await fixture.page.locator('body').innerText()).slice(0, 16000),
        serverOutput: serverOutput.join('').slice(-12000),
      }),
    );
    throw error;
  } finally {
    await fixture.context.close();
  }
}

const codex = {
  client: 'codex',
  cli: 'codex',
  provider: 'openai',
  label: 'Codex',
  installed: true,
  hasApiKey: false,
  authenticated: true,
};

test('demo pauses and restores the same review scene', async () => {
  await proof([codex], async ({ page }) => {
    await page.getByText('初稿：', { exact: false }).waitFor();
    await page.getByTestId('first-run-demo-pause').click();
    assert.equal(await page.getByTestId('first-run-demo-advance').isDisabled(), true);
    await page.reload();
    await page.getByText('初稿：', { exact: false }).waitFor();
    assert.equal(await page.getByTestId('first-run-demo-advance').isDisabled(), true);
    await page.getByTestId('first-run-demo-pause').click();
    await page.getByTestId('first-run-demo-advance').click();
    await page.getByRole('heading', { name: '审查猫找出术语' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '审查猫找出术语' }).waitFor();
    await page.getByTestId('first-run-demo-advance').click();
    await page.getByText('改稿：', { exact: false }).waitFor();
  });
});

test('pending survives reload and a fresh authentication result releases it', async () => {
  const clients = [
    { ...codex, authenticated: false },
    { ...codex, client: 'gemini', cli: 'gemini', label: 'Gemini', installed: false },
  ];
  await proof(clients, async ({ page }) => {
    await configure(page);
    await page.getByText('未安装：Gemini').waitFor();
    await page.getByTestId('first-run-login-codex').click();
    await page.getByText('等待登录', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('等待登录', { exact: true }).waitFor();
    clients[0].authenticated = true;
    await page.getByRole('button', { name: '重新检测' }).click();
    await page.getByTestId('first-run-select-codex').waitFor();
  });
});

test('no installed clients stays at setup and re-detection resumes after installation', async () => {
  const clients = [{ ...codex, installed: false }];
  await proof(clients, async ({ page }) => {
    await configure(page);
    await page.getByText('未检测到已安装的 CLI', { exact: false }).waitFor();
    clients[0].installed = true;
    await page.getByRole('button', { name: '重新检测' }).click();
    await page.getByTestId('first-run-select-codex').waitFor();
  });
});

test('native login with no account records sends builtin binding in creation requests', async () => {
  await proof([codex], async ({ page, writes }) => {
    await configure(page);
    await page.getByTestId('first-run-select-codex').click();
    await page.reload();
    await page.getByRole('heading', { name: '配置 Codex' }).waitFor();
    await page.getByTestId('first-run-connect-test').click();
    await page.getByText('连接成功', { exact: true }).waitFor();
    await page.getByTestId('first-run-create-cat').click();
    await page.getByRole('heading', { name: '团队已就绪' }).waitFor();
    assert.equal(writes.find((write) => write.path === '/api/cats').body.accountRef, 'codex');
    assert.equal(writes.filter((write) => write.path === '/api/threads').length, 1);
    const state = await page.evaluate(() => JSON.parse(localStorage.getItem('cat-cafe:onboarding-journey')));
    assert.equal(state.stage, 'ready', 'mocked creation cannot prove the first real message');
  });
});

test('Codex URL and API key account is used without native CLI login', async () => {
  const account = {
    id: 'installer-codex',
    clientId: 'openai',
    name: 'Codex via API',
    displayName: 'Codex via API',
    authType: 'api_key',
    models: ['gpt-test'],
    hasApiKey: true,
  };
  await proof(
    [{ ...codex, authenticated: false }],
    async ({ page, writes }) => {
      await configure(page);
      await page.getByTestId('first-run-select-codex').click();
      await page.getByTestId('first-run-connect-test').click();
      await page.getByText('连接成功', { exact: true }).waitFor();
      await page.getByTestId('first-run-create-cat').click();
      await page.getByRole('heading', { name: '团队已就绪' }).waitFor();
      const probe = writes.find((write) => write.path === '/api/first-run/connectivity-test')?.body;
      assert.deepEqual(probe, {
        profileId: account.id,
        clientId: 'openai',
        client: 'codex',
        model: 'gpt-test',
      });
      assert.equal(writes.find((write) => write.path === '/api/cats')?.body.accountRef, account.id);
    },
    [account],
  );
});

test('two selected clients retain the first configuration when reloading the second', async () => {
  const claude = { ...codex, client: 'claude', cli: 'claude', provider: 'anthropic', label: 'Claude' };
  await proof([codex, claude], async ({ page, writes }) => {
    await configure(page);
    await page.getByTestId('first-run-select-codex').click();
    await page.getByTestId('first-run-select-claude').click();
    await page.getByRole('button', { name: '继续配置 (2)' }).click();
    await page.getByTestId('first-run-connect-test').click();
    await page.getByText('连接成功', { exact: true }).waitFor();
    await page.getByTestId('first-run-create-cat').click();
    await page.getByRole('heading', { name: '配置 Claude' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '配置 Claude' }).waitFor();
    await page.getByTestId('first-run-connect-test').click();
    await page.getByText('连接成功', { exact: true }).waitFor();
    await page.getByTestId('first-run-create-cat').click();
    await page.getByRole('heading', { name: '团队已就绪' }).waitFor();
    const members = writes.filter((write) => write.path === '/api/cats').map((write) => write.body);
    assert.deepEqual(
      members.map((member) => member.accountRef),
      ['codex', 'claude'],
    );
    const aliases = members.flatMap((member) => member.mentionPatterns.map((pattern) => pattern.toLowerCase()));
    assert.equal(new Set(aliases).size, aliases.length);
    assert.equal(writes.filter((write) => write.path === '/api/threads').length, 1);
  });
});
