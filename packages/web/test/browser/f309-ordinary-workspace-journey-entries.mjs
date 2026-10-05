import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';

// Parent Alpha 2026-09-24 (docs/evidence/2026-09-24-f309-parent-alpha): entries that failed on the real page.
export function registerOrdinaryEntryJourneys(suite) {
  async function withRealOwner(prefix, run) {
    const evidence = await mkdtemp(`/tmp/${prefix}-`);
    const owner = await startRealWorkspaceOwner(path.join(evidence, 'data'));
    const context = await suite().browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    try {
      await run({ owner, context, errors, evidence });
    } catch (error) {
      const page = context.pages()[0];
      const body = page
        ? await page
            .locator('body')
            .innerText()
            .catch(() => 'unavailable')
        : 'no page';
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nerrors: ${errors}\nbody: ${body}`);
    } finally {
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
      await owner.close();
    }
  }

  /** Only the Settings env summary is synthetic; every workspace read behind it is the real owner. */
  async function routeSettings(context, owner, dataDirs = {}) {
    await routeThroughRealOwner(context, owner, {
      extra: async (route, url) => {
        if (url.pathname !== '/api/config/env-summary') return false;
        const dirs = { auditLogs: '', runtimeLogs: '', cliArchive: '', redisDevSandbox: '', uploads: '', ...dataDirs };
        const body =
          url.searchParams.get('surface') === 'system'
            ? { groups: {}, variables: [] }
            : { categories: {}, variables: [], paths: { projectRoot: owner.root, homeDir: '/tmp', dataDirs: dirs } };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        return true;
      },
    });
  }

  test('entry 8: a settings config-file link opens that exact file in the Hub', { timeout: 90_000 }, async () => {
    await withRealOwner('f309-entry-settings', async ({ owner, context, errors, evidence }) => {
      await routeSettings(context, owner);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(new URL('/settings?s=system', suite().baseUrl).href, { waitUntil: 'domcontentloaded' });
      await page.getByTitle('在 Hub 工作区中查看\ncat-template.json', { exact: true }).click();
      // The file itself opens: not the lobby with whatever was on the right before.
      const surface = page.getByTestId('workspace-content-review-surface');
      await surface.waitFor({ timeout: 30_000 });
      assert.notEqual(new URL(page.url()).pathname, '/settings');
      assert.equal(await surface.getAttribute('data-navigation-origin'), 'settings');
      assert.equal(await surface.locator('h2').first().getAttribute('title'), 'cat-template.json');
      await surface.screenshot({ path: `${evidence}/entry-8-settings-file.png` });
      assert.deepEqual(errors, []);
    });
  });

  // Parent Alpha 2026-09-24 second round: the upload directory's "在 Hub 中查看" left /settings unchanged.
  test(
    'entry 8: a settings data directory is shown in its Hub file tree, or says why not',
    { timeout: 90_000 },
    async () => {
      await withRealOwner('f309-entry-settings-dir', async ({ owner, context, errors, evidence }) => {
        await routeSettings(context, owner, {
          uploads: `${owner.root}/packages/api/uploads`,
          auditLogs: `${owner.root}/packages/api/f309-no-such-audit-dir`,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        const settings = new URL('/settings?s=system', suite().baseUrl).href;
        // The row as a person reads it: its label, then that row's "在 Hub 中查看".
        const hubLinkIn = (label) =>
          page.getByText(label, { exact: true }).locator('..').getByRole('button', { name: '在 Hub 中查看' });
        await page.goto(settings, { waitUntil: 'domcontentloaded' });
        await hubLinkIn('上传目录').click();

        const tree = page.getByTestId('f307-files-owner-surface');
        await tree.waitFor({ timeout: 30_000 });
        assert.notEqual(new URL(page.url()).pathname, '/settings');
        const status = tree.getByTestId('f307-files-reveal');
        await page.waitForFunction(
          () =>
            document.querySelector('[data-testid="f307-files-reveal"]')?.getAttribute('data-reveal-status') ===
            'revealed',
        );
        assert.equal(await status.textContent(), '已定位：packages/api/uploads');
        assert.equal(await tree.locator('button[title="packages/api/uploads"]').getAttribute('aria-current'), 'true');
        // Parent Alpha 2026-09-25: the tree listed its contents while its header stayed "请选择工作区" and
        // branch/HEAD "读取中…" — identity was looked up under the chat's project instead of this root.
        const identity = tree.getByTestId('f307-files-worktree-identity');
        const head = tree.getByTestId('f307-files-worktree-head');
        await page.waitForFunction(
          () => document.querySelector('[data-testid="f307-files-worktree-head"]')?.textContent !== '读取中…',
        );
        const header = await identity.innerText();
        assert.ok(!header.includes('请选择工作区'), header);
        assert.ok(!['读取中…', '未知', '读取失败', ''].includes((await head.innerText()).trim()), header);
        assert.equal(await tree.getByTestId('f307-files-worktree-identity-status').count(), 0, header);
        await tree.screenshot({ path: `${evidence}/entry-8-settings-directory.png` });

        await tree.getByRole('button', { name: '返回来源', exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/settings');
        assert.equal(new URL(page.url()).searchParams.get('s'), 'system');

        await hubLinkIn('审计日志').click();
        await page
          .getByTestId('f307-files-owner-surface')
          .getByRole('alert')
          .filter({ hasText: '工作区里没有 packages/api/f309-no-such-audit-dir' })
          .waitFor();
        assert.deepEqual(errors, []);
      });
    },
  );

  test('a .png whose bytes are JPEG ends opening with the reason', { timeout: 90_000 }, async () => {
    await withRealOwner('f309-entry-mismatched-media', async ({ owner, context, errors, evidence }) => {
      await routeThroughRealOwner(context, owner);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(suite().baseUrl, { waitUntil: 'domcontentloaded' });
      await ensureWorkspaceOpen(page);
      const home = page.getByTestId('workspace-launcher-home');
      await home.getByTestId('workspace-launcher-search').fill('opus.png');
      await home
        .getByTestId('workspace-launcher-file-result')
        .filter({ has: page.getByText('opus.png', { exact: true }) })
        .filter({ has: page.getByText('assets/avatars/', { exact: true }) })
        .click();
      const surface = page.getByTestId('workspace-content-review-surface');
      await surface.getByRole('alert').filter({ hasText: '实际内容不是可协作的图片或视频格式' }).waitFor();
      // The real owner refused the bytes; nothing is still loading behind the reason.
      assert.equal(await surface.getByText('正在打开作品', { exact: false }).count(), 0);
      await surface.screenshot({ path: `${evidence}/mismatched-media.png` });
      assert.deepEqual(errors, []);
    });
  });
}
