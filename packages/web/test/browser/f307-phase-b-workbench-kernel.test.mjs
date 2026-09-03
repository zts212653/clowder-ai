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

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const PRODUCTION_BUILD_ID_PATH = path.join(WEB_ROOT, '.next', 'BUILD_ID');
const THREAD_ID = 'thread-f307-phase-b-kernel';
const WORKTREE_ID = 'worktree-f307-kernel';
const FILE_PATH = 'docs/features/F307-composable-workbench.md';

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
  ['/api/session', { userId: 'f307-kernel-user' }],
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
  ['/api/threads', { threads: [{ id: THREAD_ID, title: 'Workbench Kernel', projectPath: '/project/cat-cafe' }] }],
  [`/api/threads/${THREAD_ID}`, { id: THREAD_ID, title: 'Workbench Kernel', projectPath: '/project/cat-cafe' }],
]);

function fixtureForApi(url) {
  const fixed = FIXED_API_FIXTURES.get(url.pathname);
  if (fixed) return fixed;
  if (url.pathname.endsWith('/task-progress')) return { taskProgress: {} };
  if (url.pathname.endsWith('/queue')) return { queue: [], paused: false, activeInvocations: [] };
  if (url.pathname.endsWith('/freshness-closures')) return { closures: [], supplements: [] };
  if (url.pathname.endsWith('/executions/active')) return { projectPath: 'default', executions: [] };
  if (url.pathname.endsWith('/invocations')) return { total: 0, invocations: [] };
  if (url.pathname === '/api/workspace/worktrees') {
    return {
      worktrees: [
        {
          id: WORKTREE_ID,
          root: '/project/cat-cafe',
          branch: 'feat/f307-phase-c',
          head: 'abc307',
        },
      ],
    };
  }
  if (url.pathname === '/api/workspace/tree') {
    return { tree: [{ name: 'F307-composable-workbench.md', path: FILE_PATH, type: 'file' }] };
  }
  if (url.pathname === '/api/workspace/search') {
    return {
      results: [
        {
          path: FILE_PATH,
          line: 1,
          content: 'Composable Workbench',
          contextBefore: '',
          contextAfter: '',
        },
      ],
    };
  }
  if (url.pathname === '/api/workspace/file') {
    return {
      path: url.searchParams.get('path') ?? FILE_PATH,
      content: '# F307 Composable Workbench\n\nKernel owner continuity.',
      sha256: 'abc307',
      size: 55,
      mime: 'text/markdown',
      truncated: false,
    };
  }
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
  testDistDirPath = await mkdtemp(path.join(WEB_ROOT, '.next-test-f307-b-'));
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
      'Phase-B Next dev must preserve the production .next/BUILD_ID artifact',
    );
  }
});

test(
  'real shell preserves owner topology across reorder, pin, split, reload, and 390px',
  { timeout: 90_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      if (window.sessionStorage.getItem('f307-b2-initialized') === '1') return;
      window.localStorage.clear();
      window.localStorage.setItem(
        'cat-cafe:f290-composable-workspace',
        JSON.stringify({ tabs: [{ surfaceId: 'must-not-revive' }] }),
      );
      window.sessionStorage.setItem('f307-b2-initialized', '1');
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/debug/callback-auth') return json(route, { error: 'forbidden' }, 403);
      return json(route, fixtureForApi(url));
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      const workbench = page.getByTestId('f307-experience-workbench');
      await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
      await page.locator('[data-chat-container]').waitFor();
      await page.getByTestId('workspace-panel-toggle').click();
      await workbench.waitFor({ timeout: 3_000 }).catch(async () => {
        await page.getByTestId('workspace-panel-toggle').click();
      });
      await workbench.waitFor({ timeout: 20_000 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-hydrated') ===
          'true',
      );
      assert.equal(await workbench.getAttribute('data-layout-owner'), 'f307');
      assert.equal(await workbench.getAttribute('data-surface-count'), '0');
      assert.equal(await workbench.getAttribute('data-workbench-focus'), 'home');
      assert.equal(await workbench.getAttribute('data-zero-topology-contract'), 'canonical-home');

      const home = page.getByTestId('workspace-launcher-home');
      await home.waitFor();
      assert.equal(
        await page.getByTestId('f307-add-surface').count(),
        0,
        'canonical Home is already the add destination and must not render a self-referential add control',
      );
      await home.getByTestId('workspace-launcher-search').fill('F307');
      await home.getByTestId('workspace-launcher-file-result').first().click();
      await page.getByTestId('workspace-file-viewer').waitFor();

      assert.equal(await workbench.getAttribute('data-surface-count'), '1');
      assert.equal(
        await page.getByTestId('f307-add-surface').count(),
        1,
        'a concrete surface restores the inline tab-strip add control',
      );
      await page.getByTestId('f307-add-surface').click();
      await home.getByTestId('workspace-launcher-dev-browser').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-surface-count') ===
          '2',
      );
      assert.equal(await workbench.getAttribute('data-surface-count'), '2');
      assert.equal((await workbench.getAttribute('data-surface-order'))?.includes('must-not-revive'), false);
      assert.equal(
        await workbench.getByTestId('workspace-file-viewer').count(),
        1,
        'inactive owner renderer must stay mounted for draft/selection/history continuity',
      );
      assert.equal(await workbench.getByTestId('workspace-file-viewer').isVisible(), false);

      await workbench.getByTestId('f307-pin-browser').click();
      await workbench.getByTestId('f307-move-left-browser').click();
      assert.equal(await workbench.getAttribute('data-pinned-surfaces'), `browser-owner:${WORKTREE_ID}`);
      assert.equal(
        await workbench.getAttribute('data-surface-order'),
        `browser-owner:${WORKTREE_ID},file-owner:${WORKTREE_ID}`,
      );

      await workbench.getByTestId('f307-split').click();
      assert.equal(await workbench.getAttribute('data-split-primary'), `browser-owner:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-split-secondary'), `file-owner:${WORKTREE_ID}`);

      const persisted = await page.evaluate(() =>
        JSON.parse(window.localStorage.getItem('cat-cafe:workbench-layout-v2') ?? 'null'),
      );
      assert.equal(persisted.schemaVersion, 2);
      assert.deepEqual(persisted.pinnedSurfaceIds, [`browser-owner:${WORKTREE_ID}`]);

      await page.reload({ waitUntil: 'domcontentloaded' });
      if (!(await workbench.isVisible())) await page.getByTestId('workspace-panel-toggle').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-hydrated') ===
          'true',
      );
      assert.equal(
        await workbench.getAttribute('data-surface-order'),
        persisted.surfaces.map((surface) => surface.id).join(','),
      );
      assert.equal(await workbench.getAttribute('data-split-secondary'), `file-owner:${WORKTREE_ID}`);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-kind') ===
          'stack',
      );
      assert.equal(await workbench.getAttribute('data-split-primary'), `browser-owner:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-split-secondary'), `file-owner:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-pinned-surfaces'), `browser-owner:${WORKTREE_ID}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  },
);
