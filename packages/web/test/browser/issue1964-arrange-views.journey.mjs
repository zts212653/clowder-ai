import assert from 'node:assert/strict';
import path from 'node:path';

/** Exercise the view entry points omitted from the original arrange journey. */
export async function verifyArrangeViewEntries(browser, fixture, evidence, errors, owner) {
  const b = fixture.store.create(owner, 'ZZ collapsed project target', '/workspace/zz-closed');
  const a = fixture.store.create(owner, 'AA arrange source', '/workspace/aa-open');
  const current = fixture.store.create(owner, 'BB arrange current', '/workspace/aa-open');
  for (const row of [a, b, current]) fixture.store.updateFavorite(row.id, true);
  const context = await browser.newContext({ viewport: { width: 300, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    localStorage.setItem('cat-cafe:shell-language', 'zh');
    localStorage.setItem('cat-cafe:sidebar:active-tab', 'project');
    localStorage.setItem('cat-cafe:sidebar:collapsed-groups', JSON.stringify(['/workspace/zz-closed']));
  });
  const ids = (locator) =>
    locator.locator('[data-thread-id]').evaluateAll((rows) => rows.map((row) => row.dataset.threadId));
  const arrange = async () => {
    const source = page.locator(`[data-attention-draggable-thread="${a.id}"]`);
    await source.scrollIntoViewIfNeeded();
    const box = await source.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.getByTestId('attention-arrange-toolbar').waitFor();
  };
  await page.goto(`${fixture.webUrl}/dev/f277-attention-preview/search`);
  const section = (projectPath) =>
    page.locator('[class~="group/section"]').filter({ has: page.locator(`[data-project-path="${projectPath}"]`) });
  const sourceSection = section('/workspace/aa-open');
  const targetSection = section('/workspace/zz-closed');
  await page.locator(`[data-thread-id="${a.id}"]`).waitFor();
  assert.deepEqual(await ids(targetSection), [], 'B starts collapsed');
  const sourceBefore = await ids(sourceSection);
  await arrange();
  await page.locator('[data-project-path="/workspace/zz-closed"]').click();
  await page.locator(`[data-thread-id="${b.id}"]`).waitFor();
  assert.deepEqual(await ids(targetSection), [b.id], 'existing B members appear after an explicit expand');
  assert.deepEqual(await ids(sourceSection), sourceBefore);
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/config/thread-attention/groups') && response.request().method() === 'POST',
    ),
    sourceSection
      .locator(`[data-attention-draggable-thread="${a.id}"]`)
      .dragTo(targetSection.locator(`[data-attention-draggable-thread="${b.id}"]`)),
  ]);
  assert.equal(saved.status(), 200);
  assert.equal(saved.request().postDataJSON().action, 'create');
  const preferences = await saved.json();
  assert.ok(preferences.groups.some((group) => [a.id, b.id].every((id) => group.threadIds.includes(id))));
  assert.deepEqual(await ids(sourceSection), sourceBefore, 'membership does not move A into project B');
  assert.deepEqual(await ids(targetSection), [b.id]);
  await page.screenshot({ path: path.join(evidence, '300-project-expand-during-arrange.png') });
  await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();

  await page.getByTestId('sidebar-view-menu').click();
  await page.getByTestId('sidebar-tab-favorites').click();
  const all = page.getByTestId('sidebar-thread-list');
  const before = await ids(all);
  assert.deepEqual(before, [a.id, current.id, b.id], 'favorites retain the daily title order and single rows');
  await arrange();
  await page
    .locator(`[data-thread-id="${b.id}"]`)
    .getByRole('button', { name: `置顶 ${b.title}`, exact: true })
    .click();
  await page
    .locator(`[data-thread-id="${b.id}"]`)
    .getByRole('button', { name: `取消置顶 ${b.title}`, exact: true })
    .waitFor();
  assert.deepEqual(await ids(all), before, 'pin fact updates without moving favorite rows');
  await page.screenshot({ path: path.join(evidence, '300-favorites-pin-during-arrange.png') });
  await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();
  assert.equal((await ids(all))[0], b.id, 'Done restores daily sorting');
  await context.close();
}
