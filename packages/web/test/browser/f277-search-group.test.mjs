import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
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
      await page.getByLabel('Group 名称', { exact: true }).fill('F311 发布工作台');
      await fetch(`${apiUrl}/__test/fail-next`, { method: 'POST' });
      await page.getByTestId('search-group-save').click();
      await editor.getByRole('alert').waitFor();
      assert.equal(await page.getByLabel('Group 名称', { exact: true }).inputValue(), 'F311 发布工作台');
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
      await page.getByLabel('整理目标').selectOption(originalGroup.id);
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
      await page.getByLabel('筛选待整理对话').fill('f311');
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
      assert.deepEqual(errors, [], `browser errors: ${errors.join('; ')}`);
      process.stdout.write(`F277 browser evidence: ${evidenceDir}\n`);
    } finally {
      await browser.close();
    }
  },
);
