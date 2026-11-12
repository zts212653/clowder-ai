import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startSearchGroupApi } from './f277-search-group.harness.mjs';
import { startSearchGroupBrowserFixture } from './f277-search-group-browser.harness.mjs';

const evidence = process.env.ISSUE1964_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'issue1964');
const owner = 'f277-search-browser-owner';

test(
  'Issue #1964: real Sidebar long press, native drag, persistence and stable geometry',
  { timeout: 240_000 },
  async () => {
    await mkdir(evidence, { recursive: true });
    let members;
    let group;
    const fixture = await startSearchGroupBrowserFixture({
      startApi: async () => {
        const api = await startSearchGroupApi();
        members = Array.from({ length: 6 }, (_, index) =>
          api.store.create(owner, `整理验收 ${index + 1}`, '/workspace/cat-cafe'),
        );
        api.store.updatePin(members[1].id, true);
        api.store.updatePin(members[2].id, true);
        const response = await api.app.inject({
          method: 'POST',
          url: '/api/config/thread-attention/groups',
          payload: {
            action: 'create',
            name: '顺序稳定验收组',
            threadIds: members.map((row) => row.id),
          },
        });
        assert.equal(response.statusCode, 200);
        group = response.json().groups.find((item) => item.name === '顺序稳定验收组');
        await api.app.inject({
          method: 'PUT',
          url: '/api/config/thread-attention',
          payload: { anchor: `group:${group.id}`, open: true },
        });
        // The preview selects the newest thread. Keep it outside the tested Group so auto-reveal
        // of a selected hidden member does not deliberately expand the preview.
        await new Promise((resolve) => setTimeout(resolve, 2));
        api.store.create(owner, '当前对话（组外）', '/workspace/cat-cafe');
        return api;
      },
    });
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    const results = [];
    try {
      for (const [width, dark, reducedMotion, tab] of [
        [300, false, 'no-preference', 'recent'],
        [240, true, 'reduce', 'recent'],
        [300, false, 'reduce', 'project'],
        [300, false, 'reduce', 'virtual'],
      ]) {
        if (tab === 'virtual')
          Array.from({ length: 60 }, (_, index) =>
            fixture.store.create(owner, `虚拟列表 ${index}`, '/workspace/virtual'),
          );
        const context = await browser.newContext({
          viewport: { width, height: width === 240 ? 520 : 860 },
          colorScheme: dark ? 'dark' : 'light',
          reducedMotion,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(
          ({ dark }) => {
            localStorage.setItem('cat-cafe:shell-presentation', 'v2');
            localStorage.setItem('cat-cafe:shell-language', 'zh');
            localStorage.setItem('cat-cafe:sidebar:active-tab', 'recent');
            localStorage.setItem('theme', dark ? 'dark' : 'light');
          },
          { dark },
        );
        await page.goto(`${fixture.webUrl}/dev/f277-attention-preview/search`);
        await page.waitForFunction(
          () => document.querySelector('[data-testid="preview-current-thread"]')?.textContent !== 'default',
        );
        if (tab === 'project') {
          await page.getByTestId('sidebar-view-menu').click();
          await page.getByTestId('sidebar-tab-project').click();
          await page.getByTestId('expand-all-btn').click();
        }
        if (tab === 'virtual') await page.getByTestId('virtual-attention-list').waitFor();
        const header = page.locator(`[data-attention-cluster="group:${group.id}"]`);
        await header.waitFor();
        const rows = page.locator('[data-thread-id]');
        const positions = () =>
          rows.evaluateAll((elements) => elements.map((el) => [el.dataset.threadId, el.getBoundingClientRect().top]));
        const order = () => rows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId));
        const memberRows = page.locator(`[data-attention-cluster-member="group:${group.id}"] [data-thread-id]`);
        await memberRows.first().waitFor();
        assert.equal(await memberRows.count(), 4);
        if (tab === 'virtual') assert.ok((await rows.count()) < 60, 'the real virtual window must be active');
        const scroller = page.getByTestId('sidebar-thread-list');
        if (width === 240) {
          await scroller.evaluate((element) => {
            element.scrollTop = 30;
          });
          assert.equal(await scroller.evaluate((element) => element.scrollTop), 30);
        }
        const before = await positions();
        const beforeOrder = await order();
        const remainder = await page.locator(`[data-sidebar-row-key="remainder:group:${group.id}"]`).textContent();
        const barHeight = (await page.getByTestId('sidebar-tabs-row').boundingBox()).height;
        const label = `${width}-${tab}`;
        await page.screenshot({ path: path.join(evidence, `${label}-01-browse.png`) });
        const source = page.locator(`[data-attention-draggable-thread="${members[1].id}"]`);
        await source.hover();
        await page.mouse.down();
        await page.getByTestId('attention-arrange-toolbar').waitFor();
        await page.mouse.up();
        assert.deepEqual(await positions(), before, 'long press must not move any row');
        assert.equal((await page.getByTestId('attention-arrange-toolbar').boundingBox()).height, barHeight);
        assert.equal(
          await page.locator(`[data-sidebar-row-key="remainder:group:${group.id}"]`).textContent(),
          remainder,
        );
        await page.screenshot({ path: path.join(evidence, `${label}-02-arrange.png`) });
        if (width === 240) {
          await scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const doneBox = await page
            .getByTestId('attention-arrange-toolbar')
            .getByRole('button', { name: '完成', exact: true })
            .boundingBox();
          assert.ok(
            doneBox.y >= 0 && doneBox.y + doneBox.height <= 520,
            'Done remains visible when scrolled to the bottom',
          );
          await scroller.evaluate((element) => {
            element.scrollTop = 30;
          });
          assert.deepEqual(await positions(), before);
        }
        await source.dragTo(page.locator(`[data-attention-draggable-thread="${members[2].id}"]`));
        await source.locator('[data-attention-arrange-hint]').waitFor();
        assert.deepEqual(await order(), beforeOrder);
        await page.screenshot({ path: path.join(evidence, `${label}-03-recent-hint.png`) });
        await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();
        assert.deepEqual(await positions(), before, 'Done with no mutation must restore the same positions');
        await page.screenshot({ path: path.join(evidence, `${label}-04-done.png`) });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (width === 300 && tab === 'recent') {
          await header.hover();
          await header.getByRole('button', { name: '更多操作', exact: true }).click();
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/api/config/thread-attention') &&
                response.request().method() === 'PUT' &&
                response.ok(),
            ),
            page.getByRole('menuitemradio', { name: /手动顺序/ }).click(),
          ]);
          await page.reload();
          await memberRows.first().waitFor();
          const first = page.locator(`[data-attention-draggable-thread="${members[0].id}"]`);
          const targetBox = await source.boundingBox();
          await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/api/config/thread-attention/groups') &&
                response.request().method() === 'POST' &&
                response.ok(),
            ),
            (async () => {
              const firstBox = await first.boundingBox();
              await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
              await page.mouse.down();
              await page.mouse.move(firstBox.x + firstBox.width / 2 + 15, firstBox.y + firstBox.height / 2, {
                steps: 5,
              });
              await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height - 2, {
                steps: 5,
              });
              await page.mouse.move(targetBox.x + targetBox.width / 2 + 1, targetBox.y + targetBox.height - 2);
              await source.locator('[aria-hidden="true"].border-t-2').waitFor();
              await page.screenshot({ path: path.join(evidence, '300-manual-insertion.png') });
              await page.mouse.up();
            })(),
          ]);
          await page.waitForFunction(
            ({ anchor, id }) =>
              document
                .querySelector(`[data-attention-cluster-member="${anchor}"] [data-thread-id]`)
                ?.getAttribute('data-thread-id') === id,
            { anchor: `group:${group.id}`, id: members[1].id },
          );
          await page
            .getByTestId('attention-arrange-toolbar')
            .getByRole('button', { name: '完成', exact: true })
            .click();
          const saved = await (await fetch(`${fixture.apiUrl}/api/config/thread-attention`)).json();
          assert.deepEqual(saved.groups.find((item) => item.id === group.id).threadIds.slice(0, 3), [
            members[1].id,
            members[0].id,
            members[2].id,
          ]);
          assert.equal(saved.memberSort[`group:${group.id}`], 'manual');
          await page.reload();
          await memberRows.first().waitFor();
          assert.deepEqual(
            (await memberRows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId))).slice(0, 3),
            [members[1].id, members[0].id, members[2].id],
          );
          await page.screenshot({ path: path.join(evidence, '300-05-manual-persisted.png') });
          await fetch(`${fixture.apiUrl}/api/config/thread-attention`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anchor: `group:${group.id}`, memberSort: null }),
          });
          await page.reload();
          await memberRows.first().waitFor();
          const prior = await order();
          const outsideId = fixture.api.threads[0].id;
          const outside = page.locator(`[data-attention-draggable-thread="${outsideId}"]`);
          const [moveResponse] = await Promise.all([
            page.waitForResponse(
              (response) =>
                response.url().endsWith('/api/config/thread-attention/groups') &&
                response.request().method() === 'POST',
            ),
            outside.dragTo(header),
          ]);
          assert.equal(moveResponse.status(), 200);
          assert.equal(Object.hasOwn(moveResponse.request().postDataJSON(), 'beforeThreadId'), false);
          await page.waitForFunction(
            ({ anchor, id }) =>
              [...document.querySelectorAll(`[data-attention-cluster-member="${anchor}"] [data-thread-id]`)].some(
                (el) => el.getAttribute('data-thread-id') === id,
              ),
            { anchor: `group:${group.id}`, id: outsideId },
          );
          assert.deepEqual(
            (await order()).filter((id) => id !== outsideId),
            prior.filter((id) => id !== outsideId),
            'membership move changes only the source row',
          );
          await page.locator(`[data-sidebar-row-key="remainder:group:${group.id}"] button`).click();
          assert.equal(await memberRows.count(), 7);
          assert.equal(
            await page.locator('[data-attention-cluster][data-expanded="true"]').count(),
            1,
            'remainder expands only its own group',
          );
          await page.screenshot({ path: path.join(evidence, '300-membership-remainder.png') });
          await page
            .getByTestId('attention-arrange-toolbar')
            .getByRole('button', { name: '完成', exact: true })
            .click();
          assert.equal(await memberRows.count(), 7, 'Done preserves the explicit reveal choice');
          await fixture.api.app.inject({
            method: 'POST',
            url: '/api/config/thread-attention/groups',
            payload: { action: 'remove', groupId: group.id, threadId: outsideId },
          });
        }
        results.push({ width, dark, reducedMotion, tab, before, remainder, barHeight });
        await context.close();
      }
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, 'result.json'),
        JSON.stringify(
          { worktree: process.cwd(), webUrl: fixture.webUrl, apiUrl: fixture.apiUrl, results, errors },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
      await fixture.close();
    }
  },
);
