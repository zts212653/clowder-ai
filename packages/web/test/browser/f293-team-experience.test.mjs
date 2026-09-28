import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { TEAM_AVATAR, TEAM_CATS, TEAM_DOSSIER_REVISION, teamRoutingReadModel } from './f293-team-fixtures.mjs';
import { realSurfaceApiResponse, THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_BIN = path.resolve(WEB_ROOT, '../../node_modules/next/dist/bin/next');
const EVIDENCE_DIR = process.env.F293_TEAM_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f293-team');

let server;
let browser;
let environment;
let baseUrl;

/** Click the attention lens and wait for the roster to actually narrow. */
async function act_setFilter(page) {
  const before = await page.locator('[data-testid^="team-cat-"]').count();
  await page.getByTestId('team-filter-attention').click();
  await page.waitForFunction(
    (previous) => document.querySelectorAll('[data-testid^="team-cat-"]').length !== previous,
    before,
    { timeout: 5_000 },
  );
}

async function findFreePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  socket.close();
  await once(socket, 'close');
  return port;
}

before(async () => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const port = await findFreePort();
  environment = await createNextDevTestEnvironment('f293-team', { NEXT_PUBLIC_API_URL: '' });
  server = spawn(process.execPath, [NEXT_BIN, 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_ROOT,
    env: environment.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  baseUrl = `http://127.0.0.1:${port}/thread/${THREAD_ID}`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(output.join(''));
    try {
      if ((await fetch(baseUrl)).ok) break;
    } catch {
      /* still compiling */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await fetch(baseUrl)).status, 200, output.join(''));
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await environment?.cleanup();
});

test(
  'the real F307 Team surface leads with partners, layers evidence, and survives 360px, dark and keyboard use',
  { timeout: 180_000 },
  async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    let snapshotReads = 0;
    let routingWrites = 0;

    await page.route('**/api/**', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/routing-context/snapshot') {
        snapshotReads += 1;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(teamRoutingReadModel()),
        });
      }
      if (url.pathname.startsWith('/api/routing-context/') && request.method() === 'POST') routingWrites += 1;
      if (url.pathname === '/api/cats') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ cats: TEAM_CATS }),
        });
      }
      const response = realSurfaceApiResponse(request, false);
      return route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 30_000 });
      await ensureWorkspaceOpen(page);
      const workbench = page.getByTestId('f307-experience-workbench');
      await workbench.waitFor({ timeout: 30_000 });

      // AC-UX6: the Team product surface is the real F307 owner surface, not a sibling host.
      await page.getByTestId('workspace-launcher-team').click();
      const panel = page.getByTestId('team-workspace-panel');
      await panel.waitFor({ timeout: 30_000 });
      assert.match(await workbench.getAttribute('data-active-surface'), /^workspace:mode:team/);
      assert.equal(
        await workbench.getAttribute('data-main-area-attention'),
        '',
        'opening Team must not steal the main area',
      );
      assert.ok(snapshotReads > 0, 'the surface must read the canonical routing read model');

      // AC-UX1: partners first — avatar, nickname, one readable capability line, honest state.
      const terra = page.getByTestId('team-cat-codex-terra');
      await terra.waitFor();
      const terraText = await terra.innerText();
      // The canonical payload calls this member 缅因猫 Terra; the nickname is what a
      // human recognises, and the near-duplicate variant label must not be echoed.
      assert.match(terraText, /小团团·砚砚/);
      assert.match(terraText, /缅因猫 Terra · gpt-5\.6-terra/);
      assert.doesNotMatch(terraText, /GPT-5\.6 Terra/);
      assert.match(terraText, /代码审查：复现问题并判断严重程度/);
      assert.match(terraText, /可接任务/);
      assert.doesNotMatch(terraText, /codex-terra/, 'the stable id does not lead the roster row');
      // An avatar that 404s still has a src attribute; only a decoded image proves the join.
      assert.equal(
        await terra.locator('img').evaluate((node) => node.complete && node.naturalWidth > 0),
        true,
        'the roster avatar must actually load, not merely carry a src',
      );
      assert.equal(await terra.locator('img').getAttribute('src'), TEAM_AVATAR);
      const rosterText = await page.getByTestId('team-members-section').innerText();
      assert.doesNotMatch(rosterText, /sha256:/, 'dossier hashes stay in the evidence fold');
      assert.match(await page.getByTestId('team-cat-opus5').innerText(), /能力资料待补充/);
      assert.match(await page.getByTestId('team-cat-opus5').innerText(), /状态待确认/);

      // AC-UX3: no empty preference form ahead of the members.
      assert.equal(await page.getByTestId('routing-preference-controls').count(), 0);
      await page.getByTestId('team-preferences-toggle').click();
      await page.getByTestId('routing-preference-controls').waitFor();
      assert.equal(
        await page.getByTestId('routing-preference-controls').locator('form').count(),
        0,
        'existing rules are read before any editor opens',
      );
      await page.getByTestId('routing-preference-open-form').click();
      await page.getByTestId('routing-preference-controls').locator('form').waitFor();
      await page.getByTestId('team-preferences-toggle').click();
      assert.equal(await page.getByTestId('routing-preference-controls').count(), 0);

      // AC-UX2/UX6: search, keyboard entry, detail layering, and a back trip that keeps the query.
      const search = page.getByTestId('team-member-search');
      await search.focus();
      await page.keyboard.type('跨仓');
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="team-cat-"]').length === 1,
        undefined,
        { timeout: 5_000 },
      );
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid')?.startsWith('team-filter-'));
      await page.getByTestId('team-cat-codex-terra').press('Enter');
      const fit = page.getByTestId('team-detail-fit');
      await fit.waitFor();
      assert.match(await fit.innerText(), /跨仓库的状态管理、发布与同步/);
      assert.match(await page.getByTestId('team-detail-cautions').innerText(), /只有几行机械修改时/);
      const evidence = page.getByTestId('team-detail-evidence');
      assert.equal(await evidence.evaluate((node) => node.open), false, 'evidence stays folded by default');
      const aboveFold = await panel.innerText();
      assert.ok(
        !aboveFold.slice(0, aboveFold.indexOf('查看依据与技术详情')).includes(TEAM_DOSSIER_REVISION),
        'the dossier revision must not lead the member detail',
      );
      await evidence.locator('summary').click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="team-detail-evidence"]')?.textContent?.includes('sha256:'),
      );
      assert.match(await evidence.innerText(), new RegExp(TEAM_DOSSIER_REVISION));
      assert.match(await evidence.innerText(), /codex-terra/);

      await page.getByTestId('team-detail-back').click();
      await page.getByTestId('team-member-search').waitFor();
      assert.equal(
        await page.getByTestId('team-member-search').inputValue(),
        '跨仓',
        'returning from a member keeps the reading context',
      );
      await page.getByTestId('team-clear-filters').count();
      await search.fill('');

      // AC-UX6 reading continuity part 1: the chosen lens survives a fold / host round trip.
      await act_setFilter(page);
      await page.getByTestId('f307-close-workspace').click();
      await ensureWorkspaceOpen(page);
      await page.getByTestId('workspace-launcher-team').click();
      await panel.waitFor({ timeout: 30_000 });
      assert.equal(
        await page.getByTestId('team-filter-attention').getAttribute('aria-pressed'),
        'true',
        'the chosen lens must survive a fold / host round trip',
      );
      await page.getByTestId('team-filter-all').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-testid^="team-cat-"]').length > 10);

      // AC-UX6 reading continuity part 2: the roster reading position. The fixture must
      // genuinely overflow — an assertion that only runs when it happens to scroll is
      // no assertion at all, so this is unconditional.
      const scrolled = await panel.evaluate((node) => {
        node.scrollTop = 240;
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
        return node.scrollTop;
      });
      assert.ok(
        scrolled > 0,
        `the roster fixture must actually overflow the panel, otherwise scroll continuity is untested (scrollTop=${scrolled})`,
      );
      // Deliberately no wait: leaving inside the 200ms debounce window is the real
      // user race, and it must commit the position through the departure cleanup
      // rather than through a timer that happened to fire first.

      const readPanelScroll = () =>
        page.evaluate(() => document.querySelector('[data-testid="team-workspace-panel"]')?.scrollTop ?? -1);
      const waitForRestoredScroll = (expected, message) =>
        page
          .waitForFunction(
            (top) =>
              Math.abs((document.querySelector('[data-testid="team-workspace-panel"]')?.scrollTop ?? -1) - top) <= 2,
            expected,
            { timeout: 5_000 },
          )
          .catch(async () => {
            throw new Error(`${message} (expected ~${expected}, got ${await readPanelScroll()})`);
          });

      // Into a member detail and back. Click through the DOM so Playwright's
      // scroll-into-view does not move the roster before we leave it.
      await panel.evaluate(() => {
        const viewportTop = document.querySelector('[data-testid="team-workspace-panel"]').getBoundingClientRect().top;
        const row = [...document.querySelectorAll('[data-testid^="team-cat-"]')].find(
          (candidate) => candidate.getBoundingClientRect().top >= viewportTop,
        );
        row?.click();
      });
      await page.getByTestId('team-detail-back').waitFor({ timeout: 10_000 });
      await page.getByTestId('team-detail-back').click();
      await page.getByTestId('team-member-search').waitFor();
      await waitForRestoredScroll(scrolled, 'returning from a member detail must replay the roster reading position');

      // And across a real fold / host round trip.
      await page.getByTestId('f307-close-workspace').click();
      await ensureWorkspaceOpen(page);
      await page.getByTestId('workspace-launcher-team').click();
      await panel.waitFor({ timeout: 30_000 });
      await waitForRestoredScroll(scrolled, 'reopening the Team surface must replay the roster reading position');

      // AC-UX6: 360px narrow column and the real dark theme, no horizontal overflow.
      // Probe a token that actually paints: the member name colour follows the F056 base.
      const memberNameColor = () =>
        page
          .getByTestId('team-cat-codex-sol')
          .evaluate((node) => window.getComputedStyle(node.querySelector('strong') ?? node).color);
      const lightNameColor = await memberNameColor();
      for (const [width, theme] of [
        [1280, 'light'],
        [360, 'light'],
        [360, 'dark'],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        if (theme === 'dark') {
          // Activate the real F056 dark base through its own persistence, not a fake attribute.
          await page.evaluate(() => {
            window.localStorage.removeItem('cat-cafe:themes');
            window.localStorage.setItem('theme', 'dark');
          });
          await page.reload({ waitUntil: 'domcontentloaded' });
          await ensureWorkspaceOpen(page);
          await panel.waitFor({ timeout: 30_000 });
          await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', undefined, {
            timeout: 15_000,
          });
          assert.notEqual(
            await memberNameColor(),
            lightNameColor,
            'the dark base must actually repaint the Team surface, not only flip an attribute',
          );
        }
        await page.getByTestId('team-cat-codex-sol').waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `the Team surface must not overflow horizontally at ${width}px`,
        );
        assert.equal(
          await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
          true,
          `the Team panel must not scroll horizontally at ${width}px`,
        );
        await page.screenshot({ path: path.join(EVIDENCE_DIR, `team-${width}-${theme}.png`), fullPage: true });
      }

      assert.equal(routingWrites, 0, 'reading the Team surface never writes routing truth');
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  },
);
