import assert from 'node:assert/strict';
import path from 'node:path';

/** Real grouping writes may span projects, while every rendered row stays in its own section. */
export async function verifyArrangeProjectMembership(page, fixture, group, otherMembers, evidence) {
  const section = (projectPath) =>
    page.locator('[class~="group/section"]').filter({
      has: page.locator(`[data-project-path="${projectPath}"]`),
    });
  const ids = (locator) =>
    locator.locator('[data-thread-id]').evaluateAll((elements) => elements.map((el) => el.dataset.threadId));
  const b = section('/workspace/other');
  const a = section('/workspace/cat-cafe');
  const sourceId = otherMembers[0].id;
  for (const action of ['move', 'create']) {
    if (action === 'create') {
      const removed = await fixture.api.app.inject({
        method: 'POST',
        url: '/api/config/thread-attention/groups',
        payload: { action: 'remove', groupId: group.id, threadId: sourceId },
      });
      assert.equal(removed.statusCode, 200);
      await page.reload();
      await page.getByTestId('sidebar-view-menu').click();
      await page.getByTestId('sidebar-tab-project').click();
      await page.getByTestId('expand-all-btn').click();
    }
    const beforeB = await ids(b);
    const beforeA = await ids(a);
    const target =
      action === 'move'
        ? a.locator(`[data-attention-cluster="group:${group.id}"]`)
        : a.locator(`[data-attention-draggable-thread="${fixture.api.threads[1].id}"]`);
    const [response] = await Promise.all([
      page.waitForResponse(
        (result) =>
          result.url().endsWith('/api/config/thread-attention/groups') && result.request().method() === 'POST',
      ),
      b.locator(`[data-attention-draggable-thread="${sourceId}"]`).dragTo(target),
    ]);
    assert.equal(response.status(), 200);
    const saved = await response.json();
    assert.equal(response.request().postDataJSON().action, action);
    assert.ok(saved.groups.some((item) => item.threadIds.includes(sourceId)));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await ids(b), beforeB, `${action}: the source stays in project B`);
    assert.deepEqual(await ids(a), beforeA, `${action}: project A does not acquire a foreign row`);
    await page.screenshot({ path: path.join(evidence, `300-project-cross-${action}.png`) });
    await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();
    assert.deepEqual(await ids(b), beforeB);
    const persisted = await (await fetch(`${fixture.apiUrl}/api/config/thread-attention`)).json();
    assert.ok(persisted.groups.some((item) => item.threadIds.includes(sourceId)));
  }
}
