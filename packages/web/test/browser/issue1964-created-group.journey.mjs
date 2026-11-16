import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A group first formed during arrange must keep its slots after an explicit collapse. */
export async function verifyCreatedGroupGeometry(browser, fixture, evidence, errors, owner) {
  const extras = Array.from({ length: 60 }, (_, index) => fixture.store.create(owner, `Created filler ${index}`, '/A'));
  const results = [];
  for (const view of ['flat', 'project', 'virtual']) {
    const [source, target, lower] = ['Create source', 'Create target', 'Lower target'].map((title) =>
      fixture.store.create(owner, title, '/A'),
    );
    const context = await browser.newContext({
      viewport: { width: 300, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      let kind = '';
      await page.route(/\/api\/threads\?view=sidebar/, (route) =>
        route.fulfill({
          json: {
            threads: [source, target, lower, ...(view === 'virtual' ? extras : [])].map((row, index) => ({
              ...row,
              lastActiveAt: Date.now() - index * 1000,
              pinned: false,
              unreadCount: row.id === target.id && kind === 'unread' ? 7 : 0,
              presence: { status: row.id === target.id && kind === 'working' ? 'working' : 'idle' },
            })),
          },
        }),
      );
      await page.addInitScript(() => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', 'zh');
        localStorage.setItem('cat-cafe:sidebar:active-tab', 'recent');
      });
      await page.goto(`${fixture.webUrl}/dev/f277-attention-preview/search`);
      const sourceRow = page.locator(`[data-attention-draggable-thread="${source.id}"]`);
      await sourceRow.waitFor();
      if (view === 'project') {
        await page.getByTestId('sidebar-view-menu').click();
        await page.getByTestId('sidebar-tab-project').click();
      }
      if (view === 'virtual') await page.getByTestId('virtual-attention-list').waitFor();
      await sourceRow.hover();
      await page.mouse.down();
      await page.getByTestId('attention-arrange-toolbar').waitFor();
      await page.mouse.up();
      const [response] = await Promise.all([
        page.waitForResponse(
          (result) =>
            result.url().endsWith('/api/config/thread-attention/groups') && result.request().method() === 'POST',
        ),
        sourceRow.dragTo(page.locator(`[data-attention-draggable-thread="${target.id}"]`)),
      ]);
      assert.equal(response.status(), 200);
      assert.equal(response.request().postDataJSON().action, 'create');
      const saved = await response.json();
      const group = saved.groups.find((item) => item.threadIds.includes(source.id));
      assert.ok(group?.threadIds.includes(target.id), 'native create persists both members');
      const header = page.locator(`[data-attention-cluster="group:${group.id}"]`);
      await header.locator('[aria-expanded="true"]').click();
      await page.waitForFunction(
        (anchor) => document.querySelector(`[data-attention-cluster="${anchor}"]`)?.dataset.expanded === 'false',
        `group:${group.id}`,
      );
      const coordinates = () =>
        page.locator(`[data-attention-draggable-thread="${lower.id}"]`).evaluate((row) => ({
          top: row.getBoundingClientRect().top,
          height: row.getBoundingClientRect().height,
        }));
      // Let the entry reading protection expire; this check isolates the new header.
      await page.waitForTimeout(600);
      const before = await coordinates();
      for (const next of ['unread', '', 'working', '']) {
        kind = next;
        await Promise.all([
          page.waitForResponse((result) => result.url().includes('/api/threads?view=sidebar') && result.ok()),
          page.evaluate(() => window.dispatchEvent(new Event('online'))),
        ]);
        if (next === 'unread') await header.getByTestId('group-count').waitFor();
        if (next === 'working') await header.getByTestId('arrange-signal-badge').waitFor();
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const after = await coordinates();
        results.push({ view, kind, before, after });
        await writeFile(path.join(evidence, 'created-group-results.json'), JSON.stringify(results, null, 2));
        assert.deepEqual(after, before, `${view}: created group ${kind || 'idle'} keeps the lower target`);
      }
      kind = 'unread';
      await Promise.all([
        page.waitForResponse((result) => result.url().includes('/api/threads?view=sidebar') && result.ok()),
        page.evaluate(() => window.dispatchEvent(new Event('online'))),
      ]);
      await page.getByTestId('attention-arrange-toolbar').getByRole('button', { name: '完成', exact: true }).click();
      await header.getByTestId('group-peek-label').waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
}
