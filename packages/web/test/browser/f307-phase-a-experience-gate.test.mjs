import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import {
  INVOCATION_ID,
  OTHER_THREAD_ID,
  OTHER_WORKTREE_ID,
  realSurfaceApiResponse,
  THREAD_ID,
  WORKTREE_ID,
} from './f307-real-surface-fixtures.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const EVIDENCE_DIR = process.env.F307_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f307-phase-c');

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

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function ensureWorkspaceOpen(page) {
  const toggle = page.getByTestId('workspace-panel-toggle');
  await toggle.waitFor();
  const workbench = page.getByTestId('f307-experience-workbench');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await workbench.isVisible()) return;
    if ((await toggle.getAttribute('aria-label')) === '打开 Workspace') await toggle.click();
    if (
      await workbench
        .waitFor({ state: 'visible', timeout: 1_000 })
        .then(() => true)
        .catch(() => false)
    )
      return;
  }
  throw new Error(
    `Workspace did not open at ${page.url()}\naria-label=${await toggle.getAttribute('aria-label')}\nbody=${(
      await page.locator('body').innerText()
    ).slice(0, 4_000)}`,
  );
}

async function assertCanonicalZeroTopologyShell(page) {
  const workbench = page.getByTestId('f307-experience-workbench');
  await workbench.waitFor({ state: 'visible' });
  assert.equal(await workbench.getAttribute('data-layout-owner'), 'f307');
  assert.equal(await workbench.getAttribute('data-layout-hydrated'), 'true');
  assert.equal(await workbench.getAttribute('data-surface-count'), '0');
  assert.equal(await workbench.getAttribute('data-workbench-focus'), 'home');
  assert.equal(
    await workbench.getAttribute('data-zero-topology-contract'),
    'canonical-home',
    'the product shell must attest that zero topology resolves to canonical Home',
  );
  await page.getByRole('heading', { name: '你想打开什么？', exact: true }).waitFor();
  assert.equal(
    await page.getByTestId('f307-add-surface').count(),
    0,
    'canonical Home is already the add destination and must not render a self-referential +',
  );
  assert.equal(await page.getByText('工作台已清空', { exact: true }).count(), 0);
  assert.equal(await page.getByText('关闭只移除了这里的承载面，对象仍由原位置保存。', { exact: true }).count(), 0);
}

async function assertOwnerRootFillsPane(surfacePane, ownerRoot) {
  const paneBox = await surfacePane.boundingBox();
  const headerBox = await surfacePane.locator(':scope > header').boundingBox();
  const ownerBox = await ownerRoot.boundingBox();
  assert.ok(paneBox && headerBox && ownerBox, 'owner surface geometry must be measurable');
  assert.ok(
    Math.abs(ownerBox.width - paneBox.width) <= 1,
    `owner host must fill the pane width (${ownerBox.width}px vs ${paneBox.width}px)`,
  );
  assert.ok(
    Math.abs(ownerBox.height - (paneBox.height - headerBox.height)) <= 1,
    `owner host must fill the pane height (${ownerBox.height}px vs ${paneBox.height - headerBox.height}px)`,
  );
  return ownerBox;
}

async function assertOwnerSurfaceFillsPane(surfacePane, ownerRoot) {
  const ownerBox = await assertOwnerRootFillsPane(surfacePane, ownerRoot);
  const renderedOwnerBox = await ownerRoot.locator(':scope > div').boundingBox();
  assert.ok(renderedOwnerBox, 'rendered owner geometry must be measurable');
  assert.ok(
    Math.abs(renderedOwnerBox.width - ownerBox.width) <= 1,
    `owner renderer must fill its host width (${renderedOwnerBox.width}px vs ${ownerBox.width}px)`,
  );
  assert.ok(
    Math.abs(renderedOwnerBox.height - ownerBox.height) <= 1,
    `owner renderer must fill its host height (${renderedOwnerBox.height}px vs ${ownerBox.height}px)`,
  );
}

let server;
let browser;
let baseUrl;
let testDistDirPath;
let testTsconfigPath;

before(async () => {
  const sync = spawnSync(process.execPath, [path.resolve(WEB_ROOT, 'scripts/sync-vendor-assets.mjs')], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
  });
  assert.equal(sync.status, 0, `vendor token sync failed:\n${sync.stdout}\n${sync.stderr}`);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  testDistDirPath = await mkdtemp(path.join(WEB_ROOT, '.next-test-f307-'));
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
});

test(
  'real owner surfaces preserve focus, lifecycle, restore, and one topology at desktop and 390px',
  { timeout: 120_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      if (window.sessionStorage.getItem('f307-phase-c-initialized') === '1') return;
      window.localStorage.clear();
      window.sessionStorage.setItem('f307-phase-c-initialized', '1');
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const terminalDeletes = [];
    let exposeBackgroundRun = false;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.route('**/api/**', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'DELETE' && url.pathname.startsWith('/api/terminal/sessions/')) {
        terminalDeletes.push(url.pathname);
      }
      const response = realSurfaceApiResponse(request, exposeBackgroundRun);
      return json(route, response.body, response.status);
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
      await page.locator('[data-chat-container]').waitFor();
      const workbench = page.getByTestId('f307-experience-workbench');
      await ensureWorkspaceOpen(page);
      await workbench.waitFor({ timeout: 20_000 }).catch(async () => {
        throw new Error(
          `F307 Workbench did not mount at ${page.url()}\npageErrors=${pageErrors.join(' | ')}\nbody=${(
            await page.locator('body').innerText()
          ).slice(0, 4_000)}`,
        );
      });
      assert.equal(await workbench.getAttribute('data-layout-owner'), 'f307');
      assert.equal(await workbench.getAttribute('data-surface-count'), '0');

      const home = page.getByTestId('workspace-launcher-home');
      await home.waitFor();
      await assertCanonicalZeroTopologyShell(page);
      assert.equal(await page.getByRole('dialog').count(), 0, 'Workspace Home is the canonical page, not a picker');
      const addSurface = page.getByTestId('f307-add-surface');
      assert.equal(
        await page.getByTestId('f307-tab-actions').count(),
        0,
        'zero topology does not reserve a tab row for an add affordance',
      );
      await page.getByTestId('approval-hub-button').click();
      await page
        .waitForFunction(
          () =>
            document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-active-surface') ===
            'workspace:mode:approval',
          undefined,
          { timeout: 20_000 },
        )
        .catch(async () => {
          throw new Error(
            `Needs Me did not focus the canonical Approval surface\nactive=${await workbench.getAttribute(
              'data-active-surface',
            )}\nsurfaces=${await workbench.getAttribute('data-surface-order')}\npageErrors=${pageErrors.join(' | ')}\nbody=${(
              await page.locator('body').innerText()
            ).slice(0, 4_000)}`,
          );
        });
      await page.getByTestId('approval-panel').waitFor({ timeout: 5_000 });
      assert.equal(
        await workbench.getAttribute('data-active-surface'),
        'workspace:mode:approval',
        'the global Needs Me entry focuses the canonical F307 Approval surface',
      );
      assert.equal(await workbench.getAttribute('data-surface-count'), '1');
      await page.getByTestId('f307-close-workspace').click();
      await assertCanonicalZeroTopologyShell(page);
      await home.getByTestId('workspace-launcher-recall').click();
      const recallPane = workbench.locator('[data-surface-id="workspace:mode:recall"]');
      const recallOwner = recallPane.getByTestId('recall-feed');
      await recallOwner.waitFor();
      assert.equal(
        await recallOwner.locator(':scope > p').count(),
        1,
        'geometry regression covers the empty Recall feed',
      );
      await assertOwnerRootFillsPane(recallPane, recallOwner);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-recall-owner-desktop.png'), fullPage: true });
      await page.getByTestId('f307-close-workspace').click();
      await assertCanonicalZeroTopologyShell(page);

      await home.getByTestId('workspace-launcher-search').fill('F307');
      await home.getByTestId('workspace-launcher-file-result').first().click();
      await page.getByTestId('workspace-file-viewer').waitFor();
      assert.equal(await workbench.getAttribute('data-active-surface'), `file-owner:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-surface-count'), '1');
      assert.equal(await workbench.getAttribute('data-workbench-focus'), 'surface');
      assert.equal(await page.getByTestId('f307-tab-code').isVisible(), true);
      await page.getByText(`Owner file: ${WORKTREE_ID}`, { exact: false }).waitFor({ timeout: 5_000 });
      const tabStrip = page.getByTestId('f307-tab-strip');
      assert.equal(
        await tabStrip.evaluate((strip) => strip.lastElementChild?.getAttribute('data-testid')),
        'f307-add-surface',
        'the add affordance stays immediately after the final Workbench tab',
      );

      await addSurface.click();
      await home.waitFor();
      assert.equal(await workbench.getAttribute('data-surface-count'), '1', 'focusing Home does not mutate topology');
      await home.getByTestId('workspace-launcher-dev-terminal').click();
      await page.getByText('Disconnected', { exact: true }).waitFor();
      assert.equal(await workbench.getAttribute('data-active-surface'), `terminal-owner:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-surface-count'), '2');
      assert.equal(await workbench.getAttribute('data-split-primary'), '');
      assert.equal(await workbench.getAttribute('data-split-secondary'), '');
      assert.equal(await page.getByTestId('f307-tab-code').isVisible(), true);
      assert.equal(await page.getByTestId('f307-tab-terminal').isVisible(), true);
      assert.equal(
        await tabStrip.evaluate((strip) => strip.lastElementChild?.getAttribute('data-testid')),
        'f307-add-surface',
      );
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '00-file-terminal-inline-add.png'), fullPage: true });

      await addSurface.click();
      await home.getByTestId('workspace-launcher-dev-browser').click();
      await page
        .waitForFunction(
          () =>
            Number(
              document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-surface-count'),
            ) >= 2,
          undefined,
          { timeout: 3_000 },
        )
        .catch(async () => {
          throw new Error(
            `Browser selection produced no second surface; pageErrors=${pageErrors.join(' | ')} body=${(
              await page.locator('body').innerText()
            ).slice(0, 3_000)}`,
          );
        });
      await workbench
        .locator(`[data-surface-id="browser-owner:${WORKTREE_ID}"]`)
        .waitFor()
        .catch(async () => {
          throw new Error(
            `real Browser owner pane missing; active=${await workbench.getAttribute('data-active-surface')} order=${await workbench.getAttribute('data-surface-order')}`,
          );
        });
      assert.equal(await workbench.getAttribute('data-active-surface'), `browser-owner:${WORKTREE_ID}`);
      const browserPane = workbench.locator(`[data-surface-id="browser-owner:${WORKTREE_ID}"]`);
      const browserOwner = browserPane.locator('[data-owner-preview]');
      await assertOwnerSurfaceFillsPane(browserPane, browserOwner);
      await browserPane.getByPlaceholder('localhost:3000').fill('localhost:4173/owner-a');
      await browserPane.getByRole('button', { name: 'Go' }).click();
      await page.waitForFunction(
        () => document.querySelector('[data-owner-preview]')?.getAttribute('data-owner-path') === '/owner-a',
      );
      assert.equal(await browserPane.locator('[data-owner-preview]').getAttribute('data-owner-port'), '4173');

      await addSurface.click();
      await home.getByTestId('workspace-launcher-artifacts').click();
      const artifactRows = page.locator('[data-artifact-row]');
      await artifactRows.filter({ hasText: 'real-surface-adapters.ts' }).click();
      assert.match(await workbench.getAttribute('data-active-surface'), /^artifact:/);
      await page.getByTestId('f307-tab-artifact').waitFor();

      await page.getByTestId('f307-tab-workspace').click();
      await artifactRows.filter({ hasText: 'PR #307 Real Surface Adapters' }).click();
      assert.match(await workbench.getAttribute('data-active-surface'), /^review:/);
      await page.getByTestId('f307-tab-review').waitFor();
      assert.equal(await workbench.getAttribute('data-surface-count'), '6');

      await page.getByTestId('f307-tab-workspace').click();
      await page.getByRole('button', { name: '全局', exact: true }).click();
      const ownerBArtifact = page.locator('[data-artifact-row]').filter({ hasText: 'owner-b.ts' });
      await ownerBArtifact.waitFor();
      await ownerBArtifact.click();
      assert.match(await workbench.getAttribute('data-active-surface'), new RegExp(`^artifact:${OTHER_THREAD_ID}:`));
      await workbench.locator(`[data-surface-id^="artifact:${OTHER_THREAD_ID}:"]`).waitFor();
      assert.equal(await workbench.getAttribute('data-surface-count'), '7');

      await page.getByTestId('f307-split').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-kind') ===
          'split',
      );
      const focusBeforeBackground = await workbench.getAttribute('data-active-surface');
      const splitBeforeBackground = [
        await workbench.getAttribute('data-split-primary'),
        await workbench.getAttribute('data-split-secondary'),
      ];
      const executionRefresh = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/executions/active';
      });
      exposeBackgroundRun = true;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await executionRefresh;
      assert.equal(await workbench.getAttribute('data-active-surface'), focusBeforeBackground);
      assert.deepEqual(
        [await workbench.getAttribute('data-split-primary'), await workbench.getAttribute('data-split-secondary')],
        splitBeforeBackground,
        'background Agent Run must not take focus or rewrite the explicit split',
      );
      assert.equal(await workbench.getAttribute('data-surface-count'), '7');
      assert.equal(
        await page.getByTestId('f307-activity-surface-ready').count(),
        0,
        'project-wide execution truth must not become a persistent Workbench activity row',
      );

      await addSurface.click();
      await page.getByTestId('f307-workspace-home-page').getByTestId('workspace-open-running-object').click();
      await page.getByTestId('invocation-trajectory-detail').waitFor({ timeout: 10_000 });
      assert.equal(await workbench.getAttribute('data-active-surface'), `agent-run:${INVOCATION_ID}`);
      assert.equal(await workbench.getAttribute('data-surface-count'), '8');
      assert.equal(
        new URL(page.url()).searchParams.has('inv'),
        false,
        'controlled Agent Run must not mutate global URL',
      );

      await page.getByTestId('f307-tab-browser').click();
      await page.getByTestId('f307-close-browser').click();
      await page.getByTestId('f307-recently-closed-toggle').click();
      await page.getByTestId('f307-restore-browser').waitFor();
      assert.equal(await workbench.locator(`[data-surface-id="browser-owner:${WORKTREE_ID}"]`).count(), 1);
      assert.equal(await workbench.locator(`[data-surface-id="browser-owner:${WORKTREE_ID}"]`).isVisible(), false);
      await page.getByTestId('f307-restore-browser').click();
      assert.equal(await workbench.getAttribute('data-active-surface'), `browser-owner:${WORKTREE_ID}`);

      await page.getByTestId('f307-tab-terminal').click();
      await page.getByTestId('f307-close-terminal').click();
      assert.deepEqual(terminalDeletes, [], 'Workbench detach must not invoke the terminal owner delete lifecycle');

      await page.getByTestId('f307-split').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-kind') ===
          'split',
      );

      const persisted = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('cat-cafe:workbench-layout-v2') ?? 'null'),
      );
      assert.equal(persisted.schemaVersion, 2);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-real-owner-journey.png'), fullPage: true });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-hydrated') ===
          'true',
      );
      assert.equal(await workbench.getAttribute('data-active-surface'), `browser-owner:${WORKTREE_ID}`);
      assert.match(await workbench.getAttribute('data-surface-order'), /artifact:/);
      assert.match(await workbench.getAttribute('data-surface-order'), new RegExp(`artifact:${OTHER_THREAD_ID}:`));
      assert.match(await workbench.getAttribute('data-surface-order'), /review:/);
      assert.match(await workbench.getAttribute('data-surface-order'), /agent-run:/);
      await page.getByRole('tab', { name: 'owner-b.ts', exact: true }).click();
      assert.match(await workbench.getAttribute('data-active-surface'), new RegExp(`^artifact:${OTHER_THREAD_ID}:`));
      await workbench.locator(`[data-surface-id^="artifact:${OTHER_THREAD_ID}:"]`).waitFor();

      await page.goto(`${new URL(baseUrl).origin}/thread/${OTHER_THREAD_ID}`, {
        waitUntil: 'domcontentloaded',
      });
      await ensureWorkspaceOpen(page);
      await page
        .waitForFunction(
          () =>
            document
              .querySelector('[data-testid="f307-experience-workbench"]')
              ?.getAttribute('data-layout-hydrated') === 'true',
        )
        .catch(async () => {
          throw new Error(
            `F307 Workbench did not restore in owner B; url=${page.url()} body=${(await page.locator('body').innerText()).slice(0, 3_000)}`,
          );
        });
      await page.getByTestId('f307-tab-code').click();
      const exactFileOwner = workbench.locator(`[data-surface-id="file-owner:${WORKTREE_ID}"] [data-owner-worktree]`);
      await exactFileOwner.waitFor();
      assert.equal(await exactFileOwner.getAttribute('data-owner-worktree'), WORKTREE_ID);
      await page.getByText(`Owner file: ${WORKTREE_ID}`, { exact: false }).waitFor();
      await page.getByTestId('f307-tab-browser').click();
      const exactBrowserOwner = browserPane.locator('[data-owner-preview]');
      assert.equal(await exactBrowserOwner.getAttribute('data-owner-preview'), WORKTREE_ID);
      assert.equal(await exactBrowserOwner.getAttribute('data-owner-port'), '4173');
      assert.equal(await exactBrowserOwner.getAttribute('data-owner-path'), '/owner-a');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      await page.getByTestId('f307-tab-code').click();
      await exactFileOwner.waitFor();
      assert.equal(await exactFileOwner.getAttribute('data-owner-worktree'), WORKTREE_ID);
      await page.getByText(`Owner file: ${WORKTREE_ID}`, { exact: false }).waitFor();
      await page.getByTestId('f307-tab-browser').click();
      assert.equal(await exactBrowserOwner.getAttribute('data-owner-port'), '4173');
      assert.equal(await exactBrowserOwner.getAttribute('data-owner-path'), '/owner-a');

      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-kind') ===
          'stack',
      );
      assert.notEqual(await workbench.getAttribute('data-split-primary'), '');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await assertOwnerSurfaceFillsPane(browserPane, exactBrowserOwner);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-browser-owner-narrow.png'), fullPage: true });
      await page.getByTestId('f307-add-surface').click();
      await home.waitFor();
      await home.getByTestId('workspace-launcher-recall').click();
      await recallOwner.waitFor();
      await assertOwnerRootFillsPane(recallPane, recallOwner);
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-recall-owner-narrow.png'), fullPage: true });
      await page.getByTestId('f307-add-surface').click();
      await home.waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await addSurface.scrollIntoViewIfNeeded();
      assert.equal(await addSurface.isVisible(), true, '390px keeps the inline add affordance reachable');
      assert.equal(
        await tabStrip.evaluate((strip) => strip.lastElementChild?.getAttribute('data-testid')),
        'f307-add-surface',
      );
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-real-owner-narrow.png'), fullPage: true });

      assert.deepEqual(pageErrors, []);
      assert.deepEqual(
        consoleErrors.filter(
          (message) =>
            !message.includes('Failed to load resource') &&
            !message.includes('WebSocket connection to') &&
            !message.includes('[ws] connect_error'),
        ),
        [],
      );
      process.stdout.write(`F307 Phase C evidence: ${EVIDENCE_DIR}\n`);
    } finally {
      await context.close();
    }
  },
);

test(
  'global Approval bell toggles the F307 right-panel chrome without exposing legacy Status',
  { timeout: 90_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => window.localStorage.clear());
    const page = await context.newPage();
    await page.route('**/api/**', (route) => {
      const response = realSurfaceApiResponse(route.request(), false);
      return json(route, response.body, response.status);
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      await assertCanonicalZeroTopologyShell(page);

      const bell = page.getByTestId('approval-hub-button');
      const workbench = page.getByTestId('f307-experience-workbench');
      const workspaceToggle = page.getByTestId('workspace-panel-toggle');
      await page.getByTestId('workspace-launcher-needs-me').click();
      await page.getByTestId('needs-me-panel').waitFor();
      await page.getByTestId('needs-me-open-action').click();
      await page
        .getByTestId('approval-panel')
        .waitFor({ timeout: 10_000 })
        .catch(async () => {
          throw new Error(
            `Needs Me inline action did not open Approval\naction=${await page
              .getByTestId('needs-me-open-action')
              .getAttribute('data-action-ref')}\nactive=${await workbench.getAttribute(
              'data-active-surface',
            )}\nsurfaces=${await workbench.getAttribute('data-surface-order')}\nbody=${(
              await page.locator('body').innerText()
            ).slice(0, 4_000)}`,
          );
        });
      assert.equal(await workbench.getAttribute('data-active-surface'), 'workspace:mode:approval');
      assert.equal(
        await workbench.getAttribute('data-surface-count'),
        '2',
        'Needs Me remains the return surface while inline Approval becomes active',
      );

      await bell.click();
      await workspaceToggle.waitFor();
      assert.equal(await workspaceToggle.getAttribute('aria-label'), '打开 Workspace');
      assert.equal(await workbench.isVisible(), false, 'the second click closes the complete right-panel chrome');
      assert.equal(
        await page
          .locator('[data-console-panel="status"]')
          .isVisible()
          .catch(() => false),
        false,
        'the bell must not fall through to the legacy Status panel',
      );

      await bell.click();
      await workbench.waitFor({ state: 'visible' });
      await page.getByTestId('approval-panel').waitFor();
      assert.equal(await workspaceToggle.getAttribute('aria-label'), '收起 Workspace');
      assert.equal(await workbench.getAttribute('data-active-surface'), 'workspace:mode:approval');
      assert.equal(await workbench.getAttribute('data-surface-count'), '2');
    } finally {
      await context.close();
    }
  },
);

test(
  'Workspace Home Files opens its persisted worktree tree before opening a file surface',
  { timeout: 90_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.clear();
    });
    const page = await context.newPage();
    await page.route('**/api/**', (route) => {
      const response = realSurfaceApiResponse(route.request(), false);
      return json(route, response.body, response.status);
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      await assertCanonicalZeroTopologyShell(page);

      const workbench = page.getByTestId('f307-experience-workbench');
      await page.getByTestId('workspace-launcher-dev-files').click();
      const treeSurface = page.getByTestId('f307-files-owner-surface');
      await treeSurface.waitFor();
      assert.equal(await treeSurface.getAttribute('data-owner-worktree'), WORKTREE_ID);
      assert.equal(await workbench.getAttribute('data-surface-count'), '1');
      assert.equal(await workbench.getAttribute('data-active-surface'), `workspace:surface:files:${WORKTREE_ID}`);

      const identity = treeSurface.getByTestId('f307-files-worktree-identity');
      await identity.waitFor();
      assert.match(await identity.innerText(), /cat-cafe/);
      assert.match(await identity.innerText(), /feat\/f307-phase-c/);
      assert.match(await identity.innerText(), /\/project\/cat-cafe/);
      assert.equal(await treeSurface.getByTitle('新建文件').count(), 1);
      assert.equal(await treeSurface.getByTitle('新建目录').count(), 1);
      assert.equal(await treeSurface.getByTitle('上传文件').count(), 1);

      const worktreeSelect = treeSurface.getByTestId('f307-files-worktree-select');
      assert.equal(await worktreeSelect.inputValue(), WORKTREE_ID);
      await worktreeSelect.selectOption(OTHER_WORKTREE_ID);
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="f307-files-owner-surface"]')?.getAttribute('data-owner-worktree') ===
          expected,
        OTHER_WORKTREE_ID,
      );
      assert.equal(await workbench.getAttribute('data-surface-count'), '1');
      assert.equal(
        await workbench.getAttribute('data-active-surface'),
        `workspace:surface:files:${OTHER_WORKTREE_ID}`,
        'switching worktree replaces the persisted Files owner instead of opening a parallel page',
      );
      assert.match(
        await treeSurface.getByTestId('f307-files-worktree-identity').innerText(),
        /fix\/f307-worktree-selector/,
      );
      assert.match(await treeSurface.getByTestId('f307-files-worktree-head').innerText(), /def307/);

      await worktreeSelect.selectOption(WORKTREE_ID);
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="f307-files-owner-surface"]')?.getAttribute('data-owner-worktree') ===
          expected,
        WORKTREE_ID,
      );
      assert.equal(await workbench.getAttribute('data-surface-count'), '1');

      const searchInput = treeSurface.getByTestId('f307-files-search-input');
      await searchInput.fill('Composable');
      await searchInput.press('Enter');
      await treeSurface.getByText('内容匹配 (1)', { exact: true }).waitFor();
      await treeSurface.locator('[data-search-result-line="120"]').last().click();
      await page.getByTestId('workspace-file-viewer').waitFor();
      const fileViewer = page.getByTestId('workspace-file-viewer');
      await fileViewer.locator('.cm-content').waitFor();
      await page.waitForFunction(() => {
        const root = document.querySelector('[data-testid="workspace-file-viewer"]');
        if (!root) return false;
        return [root, ...root.querySelectorAll('*')].some((element) => element.scrollTop > 0);
      });
      const scrollOffset = await fileViewer.evaluate((root) =>
        Math.max(0, ...[root, ...root.querySelectorAll('*')].map((element) => element.scrollTop)),
      );
      assert.ok(scrollOffset > 0);
      assert.equal(await workbench.getAttribute('data-surface-count'), '2');
      assert.equal(await workbench.getAttribute('data-active-surface'), `file-owner:${WORKTREE_ID}`);
      await page.getByText(`Owner file: ${WORKTREE_ID}`, { exact: false }).waitFor();
      await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-files-owner-tree-to-file.png'), fullPage: true });
    } finally {
      await context.close();
    }
  },
);

test('Workspace Home Status stays inside the F307 tab host', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => window.localStorage.clear());
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.route('**/api/**', (route) => {
    const response = realSurfaceApiResponse(route.request(), false);
    return json(route, response.body, response.status);
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await assertCanonicalZeroTopologyShell(page);

    const workbench = page.getByTestId('f307-experience-workbench');
    await page.getByTestId('workspace-launcher-status').click();
    await page.waitForTimeout(1_000);
    assert.equal(
      await workbench.count(),
      1,
      JSON.stringify({ pageErrors, body: (await page.locator('body').innerText()).slice(0, 4_000) }),
    );
    assert.equal(
      await workbench.getAttribute('data-surface-count'),
      '1',
      JSON.stringify({
        pageErrors,
        focus: await workbench.getAttribute('data-workbench-focus'),
        stored: await page.evaluate(() => window.localStorage.getItem('cat-cafe:workbench-layout-v2')),
        text: (await workbench.innerText()).slice(0, 2_000),
      }),
    );
    const statusPanel = page.locator('[data-console-panel="status"]');
    assert.equal(await statusPanel.count(), 1, `Status surface did not mount: ${await workbench.innerText()}`);
    assert.equal(await statusPanel.isVisible(), true, `Status surface stayed hidden: ${await workbench.innerText()}`);
    await page.getByText('消息统计', { exact: true }).waitFor();

    assert.equal(await workbench.getAttribute('data-surface-count'), '1');
    assert.equal(await workbench.getAttribute('data-active-surface'), 'workspace:host:status');
    assert.equal(await workbench.getAttribute('data-workbench-focus'), 'surface');
    assert.equal(await page.getByTestId('workspace-host-pane').isVisible(), true);
    assert.equal(await page.getByTestId('f307-tab-workspace').getAttribute('aria-selected'), 'true');
  } finally {
    await context.close();
  }
});

test(
  'Files selected from Home waits for current-project worktree discovery without discarding the click',
  { timeout: 90_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      window.localStorage.clear();
      window.localStorage.setItem(
        'cat-cafe:workbench-layout-v2',
        JSON.stringify({
          schemaVersion: 2,
          layoutOwner: 'f307',
          surfaces: [
            {
              id: 'agent-run:invocation-f307',
              type: 'agent-run',
              renderer: 'agent-run',
              title: 'clowder-ai#1408: 官网与文档发布边界',
              context: 'Invocation · invocation-f307',
              objectRef: { kind: 'agent-run', id: 'invocation-f307' },
              ownerStateRef: {
                owner: 'f299-invocation-trajectory',
                key: 'thread-f307-owner:invocation-f307',
              },
              resultTargetRef: {
                owner: 'f299-invocation-trajectory',
                key: 'thread-f307-owner:invocation-f307',
              },
              capabilities: {
                split: true,
                sidecar: true,
                pin: true,
                closePolicy: 'detach-host',
                restorePolicy: 'descriptor',
              },
            },
          ],
          pinnedSurfaceIds: [],
          activeSurfaceId: 'agent-run:invocation-f307',
          split: null,
          sidecar: null,
          recentlyClosed: [],
          activity: [],
        }),
      );
    });
    const page = await context.newPage();
    await page.route('**/api/**', async (route) => {
      const response = realSurfaceApiResponse(route.request(), false);
      if (new URL(route.request().url()).pathname === '/api/workspace/worktrees') {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
      return json(route, response.body, response.status);
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      const workbench = page.getByTestId('f307-experience-workbench');
      await workbench.waitFor();
      await page.getByTestId('f307-tab-kind-agent-run').waitFor();
      await page.getByTestId('f307-add-surface').click();
      await page.getByTestId('workspace-launcher-dev-files').click();
      await page.getByTestId('f307-destination-admission-status').waitFor();
      assert.match(await page.getByTestId('f307-destination-admission-status').innerText(), /正在读取工作区/);

      const treeSurface = page.getByTestId('f307-files-owner-surface');
      await treeSurface.waitFor();
      assert.equal(await treeSurface.getAttribute('data-owner-worktree'), WORKTREE_ID);
      assert.equal(await workbench.getAttribute('data-active-surface'), `workspace:surface:files:${WORKTREE_ID}`);
      assert.equal(await workbench.getAttribute('data-surface-count'), '2');
    } finally {
      await context.close();
    }
  },
);

test('Changes preserves its Home-selected worktree across Thread switch and reload', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    if (window.sessionStorage.getItem('f307-changes-owner-initialized') === '1') return;
    window.localStorage.clear();
    window.sessionStorage.setItem('f307-changes-owner-initialized', '1');
  });
  const page = await context.newPage();
  await page.route('**/api/**', (route) => {
    const response = realSurfaceApiResponse(route.request(), false);
    return json(route, response.body, response.status);
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await page.getByTestId('workspace-launcher-home').waitFor();
    await page.getByTestId('workspace-launcher-dev-changes').click();
    await page.getByText(`${WORKTREE_ID}.ts`, { exact: true }).waitFor();

    await page.goto(`${new URL(baseUrl).origin}/thread/${OTHER_THREAD_ID}`, {
      waitUntil: 'domcontentloaded',
    });
    await ensureWorkspaceOpen(page);
    await page.getByText(`${WORKTREE_ID}.ts`, { exact: true }).waitFor();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await page.getByText(`${WORKTREE_ID}.ts`, { exact: true }).waitFor();

    const workbench = page.getByTestId('f307-experience-workbench');
    await page.getByTestId('f307-close-workspace').click();
    await page.getByTestId('workspace-launcher-home').waitFor();
    await assertCanonicalZeroTopologyShell(page);
    await page.getByTestId('f307-recently-closed-toggle').click();
    await page.getByTestId('f307-restore-workspace').waitFor();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-zero-home-desktop.png'), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('workspace-launcher-home').waitFor();
    await assertCanonicalZeroTopologyShell(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-zero-home-narrow.png'), fullPage: true });

    await page.getByTestId('f307-restore-workspace').click();
    assert.equal(await workbench.getAttribute('data-workbench-focus'), 'surface');
    assert.equal(await workbench.getAttribute('data-surface-count'), '1');
  } finally {
    await context.close();
  }
});

test('the real Thread shell resolves invalid persisted surfaces to canonical Home', { timeout: 90_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem(
      'cat-cafe:workbench-layout-v2',
      JSON.stringify({
        schemaVersion: 2,
        layoutOwner: 'f307',
        surfaces: [
          {
            id: 'stale-owner',
            type: 'file',
            renderer: 'file-preview',
            title: 'stale.ts',
            context: 'removed owner',
            objectRef: { kind: 'file', id: 'removed-worktree' },
            ownerStateRef: { owner: 'removed-owner', key: 'removed-worktree' },
            capabilities: {
              split: true,
              sidecar: true,
              pin: true,
              closePolicy: 'detach-host',
              restorePolicy: 'descriptor',
            },
          },
        ],
        pinnedSurfaceIds: ['stale-owner'],
        activeSurfaceId: 'stale-owner',
        split: { primarySurfaceId: 'stale-owner', secondarySurfaceId: 'missing-owner' },
        sidecar: null,
        recentlyClosed: [],
        activity: [],
      }),
    );
  });
  const page = await context.newPage();
  await page.route('**/api/**', (route) => {
    const response = realSurfaceApiResponse(route.request(), false);
    return json(route, response.body, response.status);
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="f307-experience-workbench"]')?.getAttribute('data-layout-hydrated') ===
        'true',
    );
    await assertCanonicalZeroTopologyShell(page);
  } finally {
    await context.close();
  }
});
