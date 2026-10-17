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

function mockApi(route, runtimes, writes) {
  const request = route.request(),
    url = new URL(request.url());
  if (request.method() === 'POST') writes.push({ path: url.pathname, body: request.postDataJSON() });
  if (url.pathname === '/api/session') return route.fulfill({ json: { userId: 'onboarding-test' } });
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
  await page.route('**/api/**', (route) => mockApi(route, runtimes, writes));
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '重新检测', exact: true }).waitFor();
    await run({ page, writes });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(
      JSON.stringify({ url: page.url(), errors, dom: (await page.locator('body').innerText()).slice(0, 12000) }),
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
    assert.deepEqual(drafts, [['thread-1', '@codex 把我的阅读计划拆成三步']]);
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
