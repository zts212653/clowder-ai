import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { verifyGroupSorting } from './f277-group-sort-journey.mjs';
import { startSearchGroupBrowserFixture } from './f277-search-group-browser.harness.mjs';

let webUrl;
let apiUrl;
let fixture;
const evidenceDir = process.env.F277_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f277-search-group');
before(
  async () => {
    fixture = await startSearchGroupBrowserFixture();
    ({ webUrl, apiUrl } = fixture);
  },
  { timeout: 210_000 },
);
after(async () => {
  await fixture?.close();
});
const readGroups = async () => (await (await fetch(`${apiUrl}/api/config/thread-attention`)).json()).groups;
const command = async (body) => {
  const response = await fetch(`${apiUrl}/api/config/thread-attention/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};

test(
  'production Sidebar organizes across pins, retries, persists and protects undo in Chromium',
  { timeout: 180_000 },
  async () => {
    await mkdir(evidenceDir, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const threads = await (await fetch(`${apiUrl}/__test/threads`)).json();
      const [a, b, c, d] = threads;
      // Start from a known owner-scoped membership while preserving the real writer.
      for (const group of await readGroups()) {
        for (const id of group.threadIds.slice(0, -1))
          await command({ action: 'remove', groupId: group.id, threadId: id });
      }
      const seeded = await command({ action: 'create', threadIds: [c.id, d.id], name: '已有工作组' });
      const originalGroup = seeded.groups[0];
      let preferenceReads = 0;
      // Reproduce a server response arriving after the real apiFetch 30s bound.
      // Only the first GET stalls; recovery must use the same canonical endpoint.
      const slowPreferenceRead = async (route) => {
        if (route.request().method() === 'GET' && ++preferenceReads === 1) {
          await new Promise((resolve) => setTimeout(resolve, 31_500));
          await route.abort('timedout').catch(() => {});
          return;
        }
        await route.continue();
      };
      await page.route('**/api/config/thread-attention', slowPreferenceRead);
      await page.goto(`${webUrl}/dev/f277-attention-preview/search`);
      await page.locator(`[data-thread-id="${a.id}"]`).waitFor();
      await page.getByRole('tab', { name: '置顶', exact: true }).click();
      await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: '置顶' }).waitFor();
      assert.equal(await page.getByRole('tab', { name: '置顶', exact: true }).getAttribute('aria-selected'), 'true');
      assert.ok(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cafe-accent').trim()),
        'canonical theme assets must be loaded for visual evidence',
      );
      const search = page.getByPlaceholder('搜索对话、项目或 ID...');
      await search.fill('f311');
      const organize = page.getByTestId('search-group-organize');
      await organize.waitFor();
      assert.equal(await organize.textContent(), '正在读取 Group…');
      assert.equal(await organize.isDisabled(), true);
      await page.screenshot({ path: path.join(evidenceDir, '00-slow-group-read.png') });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="search-group-organize"]')?.textContent === '整理全部 3 条',
        undefined,
        { timeout: 45_000 },
      );
      assert.equal(preferenceReads, 2, 'one timeout must recover without a manual click or unbounded retry');
      assert.deepEqual(await readGroups(), [originalGroup], 'read recovery must preserve all saved membership');
      await page.unroute('**/api/config/thread-attention', slowPreferenceRead);
      assert.equal(await organize.textContent(), '整理全部 3 条');
      assert.equal(await page.getByRole('tab', { name: '置顶', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.getByTestId('search-group-tip').count(), 1);
      await page.screenshot({ path: path.join(evidenceDir, '01-search-entry.png') });
      await page.getByRole('button', { name: '关闭搜索整理提示' }).click();
      await page.reload();
      await page.getByRole('tab', { name: '最近', exact: true }).click();
      await page.getByRole('tab', { name: '置顶', exact: true }).click();
      await search.fill('f311');
      assert.equal(await page.getByTestId('search-group-tip').count(), 0);
      await organize.click();
      const editor = page.getByTestId('search-group-editor');
      assert.equal(await editor.locator(`[data-select-thread="${a.id}"]`).isChecked(), true);
      assert.equal(await editor.locator(`[data-select-thread="${b.id}"]`).isChecked(), true);
      assert.equal(await editor.locator(`[data-select-thread="${c.id}"]`).isChecked(), false);
      assert.equal(await editor.locator('input[type=checkbox]').count(), 3);
      assert.deepEqual(await readGroups(), [originalGroup], 'opening the editor must not write membership');
      const currentChat = await page.getByTestId('preview-current-thread').textContent();
      for (const label of ['搜索对话', '整理到', '新组名称'])
        assert.equal(await editor.getByText(label, { exact: true }).isVisible(), true);
      await page.setViewportSize({ width: 320, height: 900 });
      await page.screenshot({ path: path.join(evidenceDir, '00-labeled-organizer.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByLabel('新组名称', { exact: true }).fill('F311 发布工作台');
      assert.equal(await page.getByLabel('搜索对话', { exact: true }).inputValue(), 'f311');
      await fetch(`${apiUrl}/__test/fail-next`, { method: 'POST' });
      await page.getByTestId('search-group-save').click();
      await editor.getByRole('alert').waitFor();
      assert.equal(await page.getByLabel('新组名称', { exact: true }).inputValue(), 'F311 发布工作台');
      await page.screenshot({ path: path.join(evidenceDir, '02-failure-keeps-selection.png') });
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      const created = (await readGroups()).find((group) => group.name === 'F311 发布工作台');
      assert.deepEqual(new Set(created.threadIds), new Set([a.id, b.id]));
      await page.locator(`[data-attention-cluster="group:${created.id}"][data-expanded="true"]`).waitFor();
      assert.equal(await page.locator(`[data-thread-id="${b.id}"]`).count(), 1);
      assert.equal(await page.getByTestId('preview-current-thread').textContent(), currentChat);
      await page.screenshot({ path: path.join(evidenceDir, '03-group-with-unpinned-member.png') });
      await page.getByTestId('search-group-undo').click();
      await page.getByText('已撤销本次整理', { exact: true }).waitFor();
      assert.deepEqual(await readGroups(), [originalGroup]);
      await search.fill('f311');
      await organize.click();
      await page.getByLabel('整理到').selectOption(originalGroup.id);
      assert.equal(await editor.locator(`[data-select-thread="${c.id}"]`).isDisabled(), true);
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      const added = (await readGroups())[0];
      assert.equal(added.id, originalGroup.id);
      assert.equal(added.name, originalGroup.name);
      assert.deepEqual(added.threadIds.slice(0, 2), [c.id, d.id]);
      assert.equal(added.threadIds.length, 4);
      await page.getByTestId('search-group-undo').click();
      await page.getByText('已撤销本次整理', { exact: true }).waitFor();
      assert.deepEqual(await readGroups(), [originalGroup]);
      await search.fill('f311');
      await organize.click();
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      const persistent = (await readGroups()).find((group) => group.id !== originalGroup.id);
      await page.reload();
      await page.locator(`[data-attention-cluster="group:${persistent.id}"]`).waitFor();
      assert.equal(await page.locator(`[data-thread-id="${b.id}"]`).count(), 1);
      await page.getByRole('button', { name: '向 F311 添加对话', exact: true }).click();
      await page.getByLabel('搜索对话').fill('f311');
      assert.equal(await editor.locator(`[data-select-thread="${a.id}"]`).isDisabled(), true);
      await editor.locator(`[data-select-thread="${c.id}"]`).check();
      assert.match(await editor.textContent(), /将从「已有工作组」移到「F311」/);
      await page.setViewportSize({ width: 360, height: 800 });
      await page.screenshot({ path: path.join(evidenceDir, '04-narrow-add-members.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      await command({ action: 'move', groupId: persistent.id, threadId: d.id });
      const newer = await readGroups();
      await page.getByTestId('search-group-undo').click();
      await page.getByText('本次整理已无法撤销，当前分组保持不变。', { exact: true }).waitFor();
      assert.deepEqual(await readGroups(), newer, 'stale undo must retain the later membership');
      const freshThreads = await (await fetch(`${apiUrl}/__test/threads`)).json();
      assert.equal(freshThreads.find((thread) => thread.id === a.id).pinned, true);
      assert.equal(Boolean(freshThreads.find((thread) => thread.id === b.id).pinned), false);

      // A hidden legacy partner must not trap the visible survivor in a permanent conflict.
      for (const group of await readGroups()) {
        for (const id of group.threadIds.slice(0, -1))
          await command({ action: 'remove', groupId: group.id, threadId: id });
      }
      const legacy = await command({ action: 'create', threadIds: [a.id, c.id], name: '可恢复的历史组' });
      const originalMetadata = await fixture.store.getThreadMetadata(a.id);
      assert.equal(await fixture.store.softDelete(c.id), true);
      assert.deepEqual(await readGroups(), []);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await page.getByRole('tab', { name: '置顶', exact: true }).click();
      await search.fill('f311');
      assert.equal(await organize.textContent(), '整理全部 2 条');
      await organize.click();
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      await page.getByTestId('search-group-undo').click();
      await page.getByText('已撤销本次整理', { exact: true }).waitFor();
      assert.deepEqual(await fixture.store.getThreadMetadata(a.id), originalMetadata);
      assert.deepEqual(await readGroups(), []);
      assert.equal(await fixture.store.restore(c.id), true);
      assert.deepEqual(await readGroups(), legacy.groups, 'restoring the hidden partner rebuilds its original Group');

      // A member disappearing after save makes undo terminal, without overwriting any membership.
      assert.equal(await fixture.store.softDelete(c.id), true);
      await page.reload();
      await page.getByRole('tab', { name: '置顶', exact: true }).click();
      await search.fill('f311');
      await organize.click();
      await page.getByTestId('search-group-save').click();
      await editor.waitFor({ state: 'hidden' });
      assert.equal(await fixture.store.softDelete(b.id), true);
      const readMembership = () => Promise.all([a, b, c].map((thread) => fixture.store.getThreadMetadata(thread.id)));
      const afterDeletion = await readMembership();
      await page.getByTestId('search-group-undo').click();
      await page.getByText('本次整理已无法撤销，当前分组保持不变。', { exact: true }).waitFor();
      assert.equal(await page.getByTestId('search-group-undo').count(), 0);
      assert.deepEqual(
        await readMembership(),
        afterDeletion,
        'unavailable receipt members must prevent every undo write',
      );
      await page.screenshot({ path: path.join(evidenceDir, '05-member-disappeared-undo.png') });

      // Exercise the Group header with independent canonical row signals, including a done-but-unread member.
      assert.equal(await fixture.store.restore(b.id), true);
      await page.route('**/api/threads?view=sidebar', async (route) => {
        const response = await route.fetch();
        const snapshot = await response.json();
        snapshot.threads = snapshot.threads.map((thread) =>
          thread.id === a.id
            ? { ...thread, unreadCount: 3, hasUserMention: true, presence: { status: 'working' } }
            : thread.id === b.id
              ? { ...thread, unreadCount: 2, presence: { status: 'done' } }
              : thread,
        );
        await route.fulfill({ response, json: snapshot });
      });
      await page.setViewportSize({ width: 320, height: 900 });
      await page.reload();
      const statusGroup = (await readGroups()).find((group) => group.threadIds.includes(a.id));
      const header = page.locator(`[data-attention-cluster="group:${statusGroup.id}"]`);
      await header.getByText('进行中 1', { exact: true }).waitFor();
      assert.equal(await header.getByText('未读 5', { exact: true }).isVisible(), true);
      assert.equal(await header.getByText('@你 1', { exact: true }).isVisible(), true);
      const toggle = header.locator('button[aria-expanded]');
      assert.equal(await header.getAttribute('data-expanded'), 'true');
      for (const point of ['bottom-right', 'title', 'status']) {
        const wasExpanded = await header.getAttribute('data-expanded');
        if (point === 'bottom-right') {
          const box = await header.boundingBox();
          await page.mouse.click(box.x + box.width - 5, box.y + box.height - 5);
        } else if (point === 'title') {
          await header.getByText(statusGroup.name, { exact: true }).click();
        } else {
          await header.getByText('未读 5', { exact: true }).click();
        }
        await page
          .locator(`[data-attention-cluster="group:${statusGroup.id}"][data-expanded="${wasExpanded !== 'true'}"]`)
          .waitFor();
      }
      assert.equal(await header.getAttribute('data-expanded'), 'false');
      await toggle.evaluate((button) =>
        Promise.all(button.getAnimations({ subtree: true }).map((animation) => animation.finished)),
      );
      await page.screenshot({ path: path.join(evidenceDir, '06-collapsed-group-status.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      const headerBox = await header.boundingBox();
      for (const status of ['进行中 1', '未读 5', '@你 1']) {
        const box = await header.getByText(status, { exact: true }).boundingBox();
        assert.ok(box.y + box.height <= headerBox.y + headerBox.height + 1, 'status must fit the virtual row');
      }
      await toggle.focus();
      await page.keyboard.press('Enter');
      await page.locator(`[data-attention-cluster="group:${statusGroup.id}"][data-expanded="true"]`).waitFor();
      await page.keyboard.press('Space');
      await page.locator(`[data-attention-cluster="group:${statusGroup.id}"][data-expanded="false"]`).waitFor();
      await header.getByRole('button', { name: `重命名 ${statusGroup.name}`, exact: true }).click();
      await header.getByLabel('对话组名称', { exact: true }).waitFor();
      assert.equal(await header.getAttribute('data-expanded'), 'false');
      await header.getByRole('button', { name: '保存', exact: true }).click();
      await header.getByLabel('对话组名称', { exact: true }).waitFor({ state: 'hidden' });
      await header.getByRole('button', { name: `向 ${statusGroup.name} 添加对话`, exact: true }).click();
      await editor.waitFor();
      assert.equal(await editor.getByLabel('新组名称', { exact: true }).count(), 0);
      await page.getByTestId('search-group-cancel').click();
      assert.equal(await header.getAttribute('data-expanded'), 'false');
      await verifyGroupSorting(page, apiUrl, statusGroup, evidenceDir);
      assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
      process.stdout.write(`F277 browser evidence: ${evidenceDir}\n`);
    } finally {
      await browser.close();
    }
  },
);
