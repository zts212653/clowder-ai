import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The rejected drop explains its sort rule where the user released the source row. */
export async function verifyArrangeSourceFeedback(browser, fixture, evidence, errors, owner) {
  const extras = Array.from({ length: 60 }, (_, index) => fixture.store.create(owner, `Hint filler ${index}`, '/A'));
  const results = [];
  for (const language of ['zh', 'en'])
    for (const mode of ['recent', 'running-first']) {
      const members = [
        'Feedback upper neighbour',
        language === 'zh'
          ? '长列表底部的来源会话：松手以后仍然能看到排序规则说明'
          : 'Source conversation with a long title near the bottom of the list',
        'Feedback lower target',
      ].map((title) => fixture.store.create(owner, title, '/A'));
      const response = await fixture.api.app.inject({
        method: 'POST',
        url: '/api/config/thread-attention/groups',
        payload: { action: 'create', name: 'Feedback group', threadIds: members.map((row) => row.id) },
      });
      assert.equal(response.statusCode, 200);
      const group = response.json().groups.find((item) => item.threadIds.includes(members[0].id));
      await fixture.api.app.inject({
        method: 'PUT',
        url: '/api/config/thread-attention',
        payload: { anchor: `group:${group.id}`, open: true, memberSort: mode === 'recent' ? null : mode },
      });
      const context = await browser.newContext({
        viewport: { width: 240, height: 520 },
        deviceScaleFactor: 2,
        colorScheme: language === 'zh' ? 'dark' : 'light',
        reducedMotion: 'reduce',
      });
      try {
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        const writes = [];
        page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().endsWith('/api/config/thread-attention/groups'))
            writes.push(request.postDataJSON());
        });
        await page.route(/\/api\/threads\?view=sidebar/, (route) =>
          route.fulfill({
            json: {
              // Keep three rows below the group so native drag does not auto-scroll a clipped target.
              threads: [...extras.slice(0, -3), ...members, ...extras.slice(-3)].map((row, index) => ({
                ...row,
                lastActiveAt: Date.now() - index * 1000,
                pinned: false,
                unreadCount: 0,
                presence: { status: 'idle' },
              })),
            },
          }),
        );
        await page.addInitScript(
          ({ language }) => {
            localStorage.setItem('cat-cafe:shell-presentation', 'v2');
            localStorage.setItem('cat-cafe:shell-language', language);
            localStorage.setItem('cat-cafe:sidebar:active-tab', 'recent');
          },
          { language },
        );
        await page.goto(`${fixture.webUrl}/dev/f277-attention-preview/search`);
        await page.getByTestId('virtual-attention-list').waitFor();
        const scroller = page.getByTestId('sidebar-thread-list');
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const source = page.locator(`[data-attention-draggable-thread="${members[1].id}"]`);
        const target = page.locator(`[data-attention-draggable-thread="${members[2].id}"]`);
        await source.waitFor();
        await target.waitFor();
        assert.ok(
          await scroller.evaluate((element) => element.scrollTop > 200),
          'the operation really occurs below the top of a long list',
        );
        const selector = members.map((row) => `[data-attention-draggable-thread="${row.id}"]`).join(',');
        const positions = () =>
          page.locator(selector).evaluateAll((rows) =>
            rows.map((row) => ({
              id: row.dataset.attentionDraggableThread,
              top: row.getBoundingClientRect().top,
              height: row.getBoundingClientRect().height,
            })),
          );
        await source.hover();
        const before = await positions();
        assert.equal(before.length, 3);
        await page.mouse.down();
        await page.getByTestId('attention-arrange-toolbar').waitFor();
        await page.mouse.up();
        assert.deepEqual(await positions(), before, 'long press preserves the rows under the pointer');
        await source.dragTo(target);
        const feedback = source.locator('[data-attention-arrange-feedback]');
        await feedback.waitFor();
        assert.equal(
          await feedback.textContent(),
          language === 'zh'
            ? mode === 'recent'
              ? '本组按最近排列'
              : '本组按运行优先'
            : mode === 'recent'
              ? 'Recent order'
              : 'Running-first',
        );
        assert.equal(
          await feedback.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
          'the reason fits at 240px without truncation',
        );
        const box = await feedback.boundingBox();
        const sourceBox = await source.boundingBox();
        assert.ok(box.x >= sourceBox.x && box.y >= sourceBox.y && box.y + box.height <= sourceBox.y + sourceBox.height);
        assert.ok(box.y >= 0 && box.y + box.height <= 520 && box.height > 1 && box.height <= 20);
        assert.equal(await source.locator('[role="status"]').count(), 1, 'full explanation is announced once');
        assert.equal(
          await source.getByTestId('thread-pin-button').evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          }),
          true,
          'the feedback leaves the pin target reachable',
        );
        assert.deepEqual(
          await positions(),
          before,
          'the visible explanation does not move the source or its neighbours',
        );
        assert.equal(writes.length, 0, 'recent/running-first rejection sends no grouping command');
        await page.screenshot({ path: path.join(evidence, `240-source-feedback-${language}-${mode}.png`) });
        await feedback.waitFor({ state: 'hidden', timeout: 6000 });
        assert.deepEqual(await positions(), before, 'clearing feedback does not move any row');
        results.push({ language, mode, before, after: await positions(), box, writes: writes.length });
        await writeFile(
          path.join(evidence, 'source-feedback-results.json'),
          JSON.stringify({ results, errors }, null, 2),
        );
      } finally {
        await context.close();
      }
    }
}
