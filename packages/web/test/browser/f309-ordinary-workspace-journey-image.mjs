import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { fulfillFixtureApi } from './f309-ordinary-workspace-journey-actions.mjs';
import { createReviewState } from './f309-ordinary-workspace-journey-fixture.mjs';

export function registerOrdinaryImageJourney(suite) {
  test(
    'ordinary Workspace image enters collaboration from Home, preserves visible markup, and keeps a locatable discussion',
    { timeout: 90_000 },
    async () => {
      const state = createReviewState();
      const actionKinds = [];
      const { browser, baseUrl } = suite();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => window.localStorage.clear());
      const page = await context.newPage();
      const errors = [];
      const failedRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) =>
        failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`),
      );
      await page.route('**/api/**', (route) => fulfillFixtureApi(route, state, actionKinds));

      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
        await page.locator('[data-chat-container]').waitFor();
        await ensureWorkspaceOpen(page);
        const home = page.getByTestId('workspace-launcher-home');
        await home.getByTestId('workspace-launcher-search').fill('cover');
        await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).click();
        // AC-U1 (F309 feature doc :701) / Phase U plan :30: the file lands in collaboration directly.
        await page.getByTestId('workspace-content-review-surface').waitFor();
        await page.getByTestId('workspace-content-review-media').waitFor();
        await assertArtworkLayout(page, 'desktop');

        await page.getByRole('button', { name: '标注', exact: true }).click();
        await page.getByRole('button', { name: '形状', exact: true }).click();
        await page.getByRole('button', { name: '矩形', exact: true }).click();
        const canvas = page.getByTestId('review-markup-layer');
        const box = await canvas.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65);
        await page.mouse.up();
        await page.getByTestId('review-local-mark').waitFor();
        await page
          .getByTestId('workspace-content-review-surface')
          .screenshot({ path: '/tmp/cat-cafe-evidence/f309-artwork-integration/desktop-markup.png' });
        await page.getByRole('button', { name: '完成并保存', exact: true }).click();
        await page.getByTestId('review-saved-markup-layer').waitFor();

        await page.getByRole('button', { name: '评论', exact: true }).click();
        const media = page.getByTestId('workspace-content-review-media');
        const mediaBox = await media.boundingBox();
        assert.ok(mediaBox);
        await page.mouse.click(mediaBox.x + mediaBox.width * 0.45, mediaBox.y + mediaBox.height * 0.4);
        await page.getByPlaceholder('写下这条批注…').fill('这处在普通文件里需要保留讨论。');
        await page
          .getByTestId('workspace-content-review-surface')
          .screenshot({ path: '/tmp/cat-cafe-evidence/f309-artwork-integration/desktop-comment.png' });
        // Alpha 2026-09-24 A1: the bottom discussion button opens the drawer without ending comment mode.
        await page.getByRole('button', { name: '打开作品讨论', exact: true }).click();
        await page.getByRole('complementary', { name: '作品讨论', exact: true }).waitFor();
        assert.equal(
          await page.getByRole('region', { name: '作品画布工具' }).getAttribute('data-review-mode'),
          'comment',
        );
        assert.equal(await page.getByPlaceholder('写下这条批注…').inputValue(), '这处在普通文件里需要保留讨论。');
        await page.getByRole('button', { name: '关闭讨论', exact: true }).click();
        await page.getByRole('button', { name: '保存批注', exact: true }).click();
        await page.getByTestId('review-canvas-annotation-mark').waitFor();
        assert.equal(await page.getByRole('dialog', { name: '评论这处画面' }).count(), 0);
        const annotationMark = page.getByTestId('review-canvas-annotation-mark');
        const discussionThread = page.locator('li[data-annotation-id="ordinary-annotation"]');
        await annotationMark.click();
        await page.waitForFunction(
          () =>
            document.activeElement?.tagName === 'LI' &&
            document.activeElement.dataset.annotationId === 'ordinary-annotation',
        );
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark' &&
            document.activeElement.dataset.annotationId === 'ordinary-annotation',
        );
        assert.equal(await page.getByRole('complementary', { name: '作品讨论' }).count(), 0);
        await annotationMark.press('Enter');
        assert.equal(await discussionThread.evaluate((element) => element.dataset.active), 'true');
        await page.getByLabel('回复批注 ordinary-annotation').fill('已定位，继续讨论。');
        await page.getByRole('button', { name: '回复', exact: true }).click();
        await page
          .locator('[data-annotation-id="ordinary-annotation"]')
          .getByText(/已定位，继续讨论。/)
          .waitFor();
        await page.getByRole('button', { name: '标为已解决', exact: true }).click();
        await page.getByText('已解决', { exact: true }).waitFor();
        assert.deepEqual(actionKinds, ['add_visual_marks', 'reply', 'set_annotation_state']);

        await page.getByRole('button', { name: '关闭讨论', exact: true }).click();
        await page.getByRole('button', { name: '退出评论', exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await assertArtworkLayout(page, 'mobile');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.getByRole('button', { name: '返回来源', exact: true }).click();
        await page.getByTestId('workspace-launcher-home').waitFor();
        assert.equal(await page.getByTestId('workspace-launcher-search').inputValue(), 'cover');
        await page.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).waitFor();
        assert.deepEqual(errors, []);
      } catch (error) {
        const body = await page
          .locator('body')
          .innerText()
          .catch(() => 'unavailable');
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\npage errors: ${errors.join(' | ')}\nfailed requests: ${failedRequests.join(' | ')}\nbody: ${body.slice(0, 4000)}`,
        );
      } finally {
        await context.close();
      }
    },
  );
}

async function assertArtworkLayout(page, name) {
  const surface = page.getByTestId('workspace-content-review-surface');
  assert.equal(await surface.locator('textarea').count(), 0, 'viewing artwork must not require a comment form');
  assert.doesNotMatch(await surface.innerText(), /F309|owner-native|Workspace owner/);
  const canvas = await page.getByTestId('workspace-review-artwork').boundingBox();
  const toolbar = await page.getByRole('region', { name: '作品画布工具' }).boundingBox();
  const media = await page.getByTestId('workspace-content-review-media').boundingBox();
  assert.ok(canvas && toolbar && media);
  assert.ok(canvas.height > 250, 'the artwork has usable height in its real Workspace host');
  for (const box of [toolbar, media]) {
    assert.ok(
      box.x >= canvas.x &&
        box.y >= canvas.y &&
        box.x + box.width <= canvas.x + canvas.width + 1 &&
        box.y + box.height <= canvas.y + canvas.height + 1,
      'controls and media stay inside their own canvas',
    );
  }
  assert.ok(toolbar.y >= media.y + media.height - 1, 'tools stay below the visible artwork');
  await mkdir('/tmp/cat-cafe-evidence/f309-artwork-integration', { recursive: true });
  await surface.screenshot({ path: `/tmp/cat-cafe-evidence/f309-artwork-integration/${name}.png` });
  await page.screenshot({ path: `/tmp/cat-cafe-evidence/f309-artwork-integration/${name}-host.png`, fullPage: true });
}
