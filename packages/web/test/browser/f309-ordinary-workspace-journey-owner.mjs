import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';
import { routeThroughRealOwner, startRealWorkspaceOwner } from './f309-ordinary-workspace-real-owner.mjs';

export function registerOrdinaryOwnerJourney(suite) {
  test(
    'ordinary PNG saves through its real owner and reopens in an independent narrow browser',
    { timeout: 90_000 },
    async () => {
      const evidence = await mkdtemp('/tmp/f309-artwork-owner-');
      // Only the session issuer and unrelated chat shell are synthetic. F063 reads,
      // F309 writes and SQLite persistence use the shipped handlers, with private data.
      const owner = await startRealWorkspaceOwner(path.join(evidence, 'data'));
      const { api } = owner;
      const receipts = [];
      const errors = [];
      const contexts = [];
      async function openImage(viewport) {
        const context = await suite().browser.newContext({ viewport });
        contexts.push(context);
        await routeThroughRealOwner(context, owner, { onReviewPost: (receipt) => receipts.push(receipt) });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(suite().baseUrl, { waitUntil: 'domcontentloaded' });
        await ensureWorkspaceOpen(page);
        const home = page.getByTestId('workspace-launcher-home');
        await home.getByTestId('workspace-launcher-search').fill('antig-opus.png');
        await home.getByTestId('workspace-launcher-file-result').filter({ hasText: '文件名' }).first().click();
        // AC-U1 (F309 feature doc :701) / Phase U plan :30: the file lands in collaboration directly.
        await page.getByTestId('workspace-content-review-surface').waitFor();
        await page.getByTestId('workspace-content-review-media').waitFor();
        await page.getByTestId('workspace-content-review-media').evaluate((image) => image.decode());
        return page;
      }
      try {
        const page = await openImage({ width: 1280, height: 900 });
        const surface = page.getByTestId('workspace-content-review-surface');
        assert.equal(await surface.locator('textarea').count(), 0);
        await surface.screenshot({ path: `${evidence}/01-default.png` });
        await page.getByRole('button', { name: '标注', exact: true }).click();
        await page.getByRole('button', { name: '画笔', exact: true }).click();
        const box = await page.getByTestId('review-markup-layer').boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 8 });
        await page.mouse.up();
        await surface.screenshot({ path: `${evidence}/02-markup.png` });
        await page.getByRole('button', { name: '完成并保存', exact: true }).click();
        await page.getByTestId('review-saved-markup-layer').waitFor();
        await page.getByRole('button', { name: '评论', exact: true }).click();
        const image = await page.getByTestId('workspace-content-review-media').boundingBox();
        assert.ok(image);
        await page.mouse.click(image.x + image.width * 0.45, image.y + image.height * 0.4);
        await page.getByPlaceholder('写下这条批注…').fill('普通 PNG：这处评论保留在作品现场。');
        await surface.screenshot({ path: `${evidence}/03-comment.png` });
        await page.getByRole('button', { name: '保存批注', exact: true }).click();
        await page.getByTestId('review-canvas-annotation-mark').waitFor();
        await page.getByTestId('review-canvas-annotation-mark').click();
        await page.getByText('普通 PNG：这处评论保留在作品现场。', { exact: true }).waitFor();
        await surface.screenshot({ path: `${evidence}/04-discussion.png` });
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: '退出评论', exact: true }).click();
        const mobile = await openImage({ width: 390, height: 844 });
        assert.equal(await mobile.getByTestId('review-saved-markup-layer').count(), 1);
        assert.equal(await mobile.getByTestId('review-canvas-annotation-mark').count(), 1);
        await mobile
          .getByTestId('workspace-content-review-surface')
          .screenshot({ path: `${evidence}/05-independent-390.png` });
        await mobile.getByTestId('review-canvas-annotation-mark').click();
        await mobile.getByText('普通 PNG：这处评论保留在作品现场。', { exact: true }).waitFor();
        await mobile
          .getByTestId('workspace-content-review-surface')
          .screenshot({ path: `${evidence}/06-390-discussion.png` });
        const last = receipts.at(-1);
        assert.ok(receipts.every((receipt) => receipt.status === 200));
        assert.equal(last.response.review.annotations.length, 1);
        assert.equal(last.response.review.visualMarks.length, 1);
        assert.deepEqual(errors, []);
        await writeFile(
          `${evidence}/result.json`,
          JSON.stringify(
            {
              outcome: 'pass',
              scope: 'real owner routes/SQLite/bytes, test session and ancillary thread shell',
              api,
              errors,
              receipts,
            },
            null,
            2,
          ),
        );
        console.log(`Owner evidence: ${evidence}`);
      } catch (error) {
        await writeFile(
          `${evidence}/failure.json`,
          JSON.stringify({ error: String(error), stack: error.stack, errors, receipts }, null, 2),
        );
        throw error;
      } finally {
        // The collaboration landing opens at once, so a media read can still be proxied when the
        // journey ends; stop proxying before disposal instead of rejecting after the test.
        await Promise.all(contexts.map((context) => context.unrouteAll({ behavior: 'ignoreErrors' })));
        await Promise.all(contexts.map((context) => context.close()));
        await owner.close();
      }
    },
  );
}
