import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const PRODUCTION_BUILD_ID_PATH = path.join(WEB_ROOT, '.next', 'BUILD_ID');
const THREAD_ID = 'thread-f295-parallel';

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
    } catch {
      // The real Thread route is still compiling.
    }
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

async function readProductionBuildId() {
  if (!existsSync(PRODUCTION_BUILD_ID_PATH)) return null;
  return readFile(PRODUCTION_BUILD_ID_PATH, 'utf8');
}

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const FIXED_API_FIXTURES = new Map([
  ['/api/session', { userId: 'f295-parallel-user' }],
  ['/api/health', { status: 'ok' }],
  ['/api/ready', { status: 'ok' }],
  [
    '/api/cats',
    {
      cats: [
        {
          id: 'codex-sol',
          displayName: '小太阳·砚砚',
          color: { primary: 'var(--color-codex-primary)', secondary: 'var(--color-codex-bg)' },
          mentionPatterns: ['@codex-sol'],
          clientId: 'openai',
          defaultModel: 'gpt-5.6-sol',
          avatar: '',
          roleDescription: '',
          personality: '',
          roster: { available: true },
        },
      ],
    },
  ],
  ['/api/config/cat-order', { catOrder: ['codex-sol'] }],
  ['/api/messages', { messages: [], hasMore: false }],
  ['/api/tasks', { tasks: [] }],
  ['/api/bootcamp/threads', { threads: [] }],
  ['/api/threads', { threads: [{ id: THREAD_ID, title: 'Parallel sampling', projectPath: '/project/cat-cafe' }] }],
  [`/api/threads/${THREAD_ID}`, { id: THREAD_ID, title: 'Parallel sampling', projectPath: '/project/cat-cafe' }],
]);

function fixtureForApi(url) {
  const fixed = FIXED_API_FIXTURES.get(url.pathname);
  if (fixed) return fixed;
  if (url.pathname.endsWith('/task-progress')) return { taskProgress: {} };
  if (url.pathname.endsWith('/queue')) return { queue: [], paused: false, activeInvocations: [] };
  if (url.pathname.endsWith('/freshness-closures')) return { closures: [], supplements: [] };
  if (url.pathname.endsWith('/executions/active')) return { projectPath: 'default', executions: [] };
  if (url.pathname.endsWith('/invocations')) return { total: 0, invocations: [] };
  if (url.pathname === '/api/workspace/worktrees') return { worktrees: [] };
  if (url.pathname === '/api/workspace/tree') return { tree: [] };
  if (url.pathname === '/api/workspace/search') return { results: [] };
  if (url.pathname === '/api/preview/status') return { available: false, gatewayPort: 0 };
  if (url.pathname === `/api/threads/${THREAD_ID}/artifacts`) return { threadId: THREAD_ID, artifacts: [] };
  return {};
}

let server;
let browser;
let baseUrl;
let productionBuildId;
let testDistDirPath;
let testTsconfigPath;

before(async () => {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  productionBuildId = await readProductionBuildId();
  testDistDirPath = await mkdtemp(path.join(WEB_ROOT, '.next-test-f295-parallel-'));
  const testDistDir = path.basename(testDistDirPath);
  testTsconfigPath = path.join(WEB_ROOT, `tsconfig.${testDistDir.slice(1)}.json`);
  await writeFile(
    testTsconfigPath,
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { noEmit: true },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', `${testDistDir}/types/**/*.ts`],
        exclude: ['node_modules'],
      },
      null,
      2,
    )}\n`,
  );
  const port = await findFreePort();
  const output = [];
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: '',
      CAT_CAFE_DEPLOYMENT_ID: 'feature-test',
      CAT_CAFE_WEB_TEST_DIST_DIR: testDistDir,
      CAT_CAFE_WEB_TEST_TSCONFIG: path.basename(testTsconfigPath),
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/thread/${THREAD_ID}`;
  await waitForPage(baseUrl, server, output);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  if (testDistDirPath) await rm(testDistDirPath, { recursive: true, force: true });
  if (testTsconfigPath) await rm(testTsconfigPath, { force: true });
  if (productionBuildId !== null) {
    assert.equal(
      await readProductionBuildId(),
      productionBuildId,
      'F295 Next dev must preserve the production .next/BUILD_ID artifact',
    );
  }
});

const parallelExecutions = ['codex-astra', 'fable5'].map((catId) => ({
  kind: 'live_invocation',
  executionId: 'shared-parent',
  threadId: THREAD_ID,
  threadTitle: 'Parallel sampling',
  catId,
  startedAt: 100,
  cancelability: {
    state: 'cancelable',
    target: { kind: 'live_invocation', threadId: THREAD_ID, catId, executionId: 'shared-parent' },
  },
}));

test(
  'parallel cats remain visible and independently cancelable in the real Workspace',
  { timeout: 90_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const cancelTargets = [];
    let executions = [...parallelExecutions];
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/debug/callback-auth') return json(route, { error: 'forbidden' }, 403);
      if (url.pathname === '/api/executions/active') {
        return json(route, { projectPath: '/project/cat-cafe', executions });
      }
      if (url.pathname.endsWith('/executions/live/shared-parent/cancel')) {
        const { catId } = route.request().postDataJSON();
        cancelTargets.push({ pathname: url.pathname, catId });
        executions = executions.filter((execution) => execution.catId !== catId);
        return json(route, { ok: true, cancelled: true });
      }
      return json(route, fixtureForApi(url));
    });
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
      await page.locator('[data-chat-container]').waitFor();
      await ensureWorkspaceOpen(page);
      const surface = page.getByTestId('workspace-developing');
      await surface.waitFor();
      await surface.getByRole('heading', { name: '2 件工作正在进行' }).waitFor();
      const rows = surface.getByTestId('workspace-running-object');
      assert.equal(await rows.count(), 2);
      assert.match(await rows.nth(0).innerText(), /codex-astra/);
      assert.match(await rows.nth(1).innerText(), /fable5/);
      console.log(`F295 browser: ${baseUrl} shows both parallel cats`);
      if (process.env.F295_SCREENSHOT_PATH) await surface.screenshot({ path: process.env.F295_SCREENSHOT_PATH });
      await surface
        .getByRole('button', { name: 'Stop codex-astra live_invocation shared-parent', exact: true })
        .click();
      await surface.getByRole('heading', { name: '一件工作正在进行' }).waitFor();
      assert.equal(await rows.count(), 1);
      assert.match(await rows.first().innerText(), /fable5/);
      assert.equal(
        await surface
          .getByRole('button', { name: 'Stop fable5 live_invocation shared-parent', exact: true })
          .isEnabled(),
        true,
      );
      assert.deepEqual(cancelTargets, [
        { pathname: `/api/threads/${THREAD_ID}/executions/live/shared-parent/cancel`, catId: 'codex-astra' },
      ]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      await surface.getByRole('heading', { name: '一件工作正在进行' }).waitFor();
      assert.equal(await rows.count(), 1);
      assert.match(await rows.first().innerText(), /fable5/);
      assert.deepEqual(pageErrors, []);
      console.log('F295 browser: stopping Astra leaves Fable visible and cancelable; reload preserves Fable');
    } finally {
      await context.close();
    }
  },
);
