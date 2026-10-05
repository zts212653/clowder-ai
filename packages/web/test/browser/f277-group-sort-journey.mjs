import assert from 'node:assert/strict';
import path from 'node:path';

/** Real preference writer + live Sidebar refresh: compare pixels, not just DOM order. */
export async function verifyGroupSorting(page, apiUrl, group, evidenceDir) {
  const [a, b] = group.threadIds;
  let working = b;
  let workingStart = Date.now() - 60_000;
  let concurrentWorking;
  let concurrentStart;
  let unread = 3;
  await page.unroute('**/api/threads?view=sidebar');
  await page.route('**/api/threads?view=sidebar', async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.threads = snapshot.threads.map((thread) => ({
      ...thread,
      unreadCount: thread.id === a ? unread : 0,
      presence: {
        status: thread.id === working || thread.id === concurrentWorking ? 'working' : 'done',
        activeSince:
          thread.id === concurrentWorking ? concurrentStart : thread.id === working ? workingStart : undefined,
      },
    }));
    await route.fulfill({ response, json: snapshot });
  });
  await page.reload();
  const header = page.locator(`[data-attention-cluster="group:${group.id}"]`);
  const toggle = header.locator('button[aria-expanded]');
  const control = header.getByRole('combobox', { name: `${group.name} 组内排序`, exact: true });
  await control.waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="preview-current-thread"]')?.textContent !== 'default',
  );
  // Commit an explicit tab transition after hydration, as the main search journey does.
  await page.getByRole('tab', { name: '最近', exact: true }).click();
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: '最近' }).waitFor();
  await page.getByRole('tab', { name: '置顶', exact: true }).click();
  await page.locator('[role="tab"][aria-selected="true"]').filter({ hasText: '置顶' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '置顶', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await control.inputValue(), 'manual');
  await control.selectOption('running-first');
  await page.waitForFunction((anchor) => {
    const select = document.querySelector(`[data-attention-cluster="${anchor}"] select`);
    return select?.value === 'running-first' && !select.disabled;
  }, `group:${group.id}`);
  assert.equal(await header.getAttribute('data-expanded'), 'false', 'select never toggles the header');
  await toggle.click();
  const rows = page.locator(`[data-attention-cluster-member="group:${group.id}"] [data-thread-id]`);
  await rows.first().waitFor();
  assert.deepEqual(await rows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId)), [b, a]);
  const positions = () =>
    page
      .locator('[data-thread-id]')
      .evaluateAll((elements) => elements.map((el) => [el.dataset.threadId, el.getBoundingClientRect().top]));
  const before = await positions();
  working = a;
  unread = 0;
  await page.getByRole('button', { name: '全部已读', exact: true }).click();
  await header.getByText('未读 3', { exact: true }).waitFor({ state: 'hidden' });
  await header.getByText('进行中 1', { exact: true }).waitFor();
  await page
    .locator(`[data-thread-id="${a}"]`)
    .getByText(/^执行中(?: · \d+分)?$/)
    .waitFor();
  assert.deepEqual(await positions(), before, 'read/status refresh cannot move the open Group or its member rows');
  assert.equal(await page.getByRole('tab', { name: '置顶', exact: true }).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: path.join(evidenceDir, '07-running-sort-stable.png') });
  const controlBox = await control.boundingBox();
  const titleBox = await header.getByText(group.name, { exact: true }).boundingBox();
  assert.ok(titleBox.x + titleBox.width <= controlBox.x, '320px title and sort control must not overlap');

  const outside = (await (await fetch(`${apiUrl}/__test/threads`)).json()).find(
    (thread) => thread.pinned && !group.threadIds.includes(thread.id),
  );
  assert.ok(outside, 'fixture needs an independent pinned thread');
  working = outside.id;
  // The mark-all-read control disappears once unread is zero. Exercise the
  // production online-invalidation path without remounting the reading session.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page
    .locator(`[data-thread-id="${outside.id}"]`)
    .getByText(/^执行中(?: · \d+分)?$/)
    .waitFor();
  assert.equal(
    await page.locator('[data-thread-id]').first().getAttribute('data-thread-id'),
    outside.id,
    'an open Group cannot suppress canonical promotion of independent work',
  );
  assert.equal(await header.getAttribute('data-expanded'), 'true');
  assert.deepEqual(await rows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId)), [b, a]);
  await page.screenshot({ path: path.join(evidenceDir, '08-outside-working-promoted.png') });
  working = a;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page
    .locator(`[data-thread-id="${a}"]`)
    .getByText(/^执行中(?: · \d+分)?$/)
    .waitFor();
  await toggle.click();
  await toggle.click();
  await rows.first().waitFor();
  assert.deepEqual(await rows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId)), [a, b]);
  const saved = await (await fetch(`${apiUrl}/api/config/thread-attention`)).json();
  assert.equal(saved.memberSort[`group:${group.id}`], 'running-first');
  assert.deepEqual(saved.groups.find((entry) => entry.id === group.id).threadIds, group.threadIds);

  concurrentWorking = outside.id;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page
    .locator(`[data-thread-id="${outside.id}"]`)
    .getByText(/^执行中(?: · \d+分)?$/)
    .waitFor();
  assert.equal(await page.locator('[data-thread-id]').first().getAttribute('data-thread-id'), a);
  concurrentStart = workingStart - 60_000;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(
    (id) => document.querySelector('[data-thread-id]')?.getAttribute('data-thread-id') === id,
    outside.id,
  );
  assert.equal(await header.getAttribute('data-expanded'), 'true');
  assert.deepEqual(await rows.evaluateAll((elements) => elements.map((el) => el.dataset.threadId)), [a, b]);
  await page.screenshot({ path: path.join(evidenceDir, '09-outside-working-start-refined.png') });

  const refinedPositions = await positions();
  workingStart = concurrentStart - 60_000;
  unread = 1;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await header.getByText('未读 1', { exact: true }).waitFor();
  assert.deepEqual(await positions(), refinedPositions, 'only the reading Group changed; its placement stays stable');
  await page.reload();
  await control.waitFor();
  assert.equal(await control.inputValue(), 'running-first');
}
