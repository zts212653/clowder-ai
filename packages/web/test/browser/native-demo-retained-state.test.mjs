import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openLiveJourney, roleIdentity } from './native-team-live.harness.mjs';
import { assertLivePageHealthy, verifyVisibleRoute } from './native-team-observers.mjs';

// Installed-renderer acceptance. No API, model or Service Worker interception.
// Use an owned instance whose real first-run journey has already completed.
test(
  'installed demo replay preserves completed receipt, roles, history, pins and shell',
  { timeout: 120000 },
  async () => {
    const journey = await openLiveJourney();
    const { page, request, web, record, log } = journey;
    let originalBookmarks;
    const demo = page.getByRole('dialog').filter({ has: page.getByTestId('demo-transcript') });
    const bookmarkPrefix = 'cat-cafe:scripted-onboarding:v1:';
    const bookmarks = () =>
      page.evaluate((prefix) => Object.entries(localStorage).filter(([key]) => key.startsWith(prefix)), bookmarkPrefix);
    const readReceipt = async () => {
      const result = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        return { status: response.status, body: await response.json() };
      }, new URL('/api/config/onboarding', journey.api).href);
      assert.equal(result.status, 200, 'Use the actual browser session, not a legacy identity header');
      return result.body;
    };
    const writes = [];
    page.on('request', (req) => {
      const pathname = new URL(req.url()).pathname;
      if (
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method()) &&
        ['/api/cats', '/api/messages', '/api/config/onboarding'].some((path) => pathname.startsWith(path))
      )
        writes.push({ method: req.method(), pathname });
    });
    try {
      await page.goto(new URL('/?lang=zh', web).href);
      await verifyVisibleRoute(page, record, 'new-conversation-page');
      const receipt = await readReceipt();
      assert.equal(receipt.status, 'completed', 'Do not consume an unused delivery environment');
      const roles = (await request('/api/cats')).cats.map(roleIdentity);
      assert.ok(roles.length > 0, 'This is retained-user acceptance, not first-install evidence');
      const history = await request('/api/messages?threadId=default&limit=50');
      assert.equal(await demo.count(), 0, 'A returning user must not receive an automatic demo');
      const preference = await page.evaluate(() => ({
        pins: localStorage.getItem('cat-cafe:pinned-settings-sections'),
        shell: localStorage.getItem('cat-cafe:shell-presentation'),
      }));
      originalBookmarks = await bookmarks();
      record.originalBookmarks = originalBookmarks;
      const pins = await page
        .locator('[data-testid^="rail-pin-"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid')));
      await page.getByTestId('empty-state-bootcamp').click();
      await demo.getByRole('button', { name: '暂停', exact: true }).click();
      const pausedTranscript = await page.getByTestId('demo-transcript').innerText();
      const pausedBookmark = await bookmarks();
      assert.ok(pausedBookmark.length > 0);
      assert.ok(pausedBookmark.some(([, raw]) => JSON.parse(raw).paused === true));
      await page.waitForTimeout(1800);
      assert.equal(await page.getByTestId('demo-transcript').innerText(), pausedTranscript);
      assert.deepEqual(await bookmarks(), pausedBookmark, 'Pause must stop the real player timer');
      await journey.screenshot('retained-demo-paused');
      await log('pause-does-not-advance-the-real-player');

      await page.reload();
      await verifyVisibleRoute(page, record, 'new-conversation-page');
      assert.equal(await demo.count(), 0, 'Reload must respect the server completion receipt');
      assert.deepEqual(await bookmarks(), pausedBookmark, 'Reload must retain the local playback bookmark');
      await page.getByTestId('empty-state-bootcamp').click();
      await demo.getByRole('button', { name: '暂停', exact: true }).waitFor();
      const resumed = await bookmarks();
      assert.ok(
        resumed.some(([, raw]) => JSON.parse(raw).paused === false),
        'Manual open resumes automatically',
      );
      for (const [key, raw] of pausedBookmark) {
        const current = JSON.parse(resumed.find(([candidate]) => candidate === key)?.[1] ?? 'null');
        assert.ok(current && current.index >= JSON.parse(raw).index, 'Reopening must not reset to an earlier event');
      }
      await demo.getByRole('button', { name: '关闭引导', exact: true }).click();
      await demo.waitFor({ state: 'hidden' });
      assert.deepEqual(await readReceipt(), receipt, 'Close cannot downgrade a completed receipt');
      await page.getByTestId('empty-state-bootcamp').click();
      await demo.getByRole('button', { name: '暂停', exact: true }).waitFor();
      await demo.getByRole('link', { name: /创建我的猫猫 →$/ }).click();
      await verifyVisibleRoute(page, record, 'member-list-page');
      assert.equal(await page.getByTestId('recommended-team-setup').count(), 0, 'Existing roles bypass first creation');
      assert.equal(await demo.count(), 0);
      await page.waitForFunction(() => {
        const control = document.querySelector('select[aria-label="默认猫"]');
        return (
          control &&
          !control.disabled &&
          control.value &&
          !document.querySelector('.member-defaults')?.textContent.includes('正在读取')
        );
      });
      await journey.screenshot('retained-members-after-demo');
      await page.reload();
      await verifyVisibleRoute(page, record, 'member-list-page');
      assert.deepEqual(
        await page.evaluate(() => ({
          pins: localStorage.getItem('cat-cafe:pinned-settings-sections'),
          shell: localStorage.getItem('cat-cafe:shell-presentation'),
        })),
        preference,
      );
      assert.deepEqual(
        await page
          .locator('[data-testid^="rail-pin-"]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid'))),
        pins,
      );
      assert.deepEqual((await request('/api/cats')).cats.map(roleIdentity), roles);
      assert.deepEqual(await request('/api/messages?threadId=default&limit=50'), history);
      assert.deepEqual(await readReceipt(), receipt);
      assert.deepEqual(writes, [], 'Playback/navigation cannot create roles, send tasks or rewrite completion');
      assertLivePageHealthy(record);
      await log('retained-replay-navigation-and-reload-preserve-real-state', { roles: roles.length, pins, receipt });
    } catch (error) {
      record.failure = error.message;
      await journey.screenshot('retained-demo-failure').catch(() => {});
      throw error;
    } finally {
      if (await demo.isVisible()) await demo.getByRole('button', { name: '关闭引导', exact: true }).click();
      if (originalBookmarks)
        await page.evaluate(
          ({ prefix, entries }) => {
            for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key);
            for (const [key, value] of entries) localStorage.setItem(key, value);
          },
          { prefix: bookmarkPrefix, entries: originalBookmarks },
        );
      await journey.close();
    }
  },
);
