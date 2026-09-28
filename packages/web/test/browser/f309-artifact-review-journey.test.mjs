import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import {
  openReviewPanel,
  selectMarkupColor,
  selectMarkupTool,
  selectReviewMode,
} from './fixtures/f309-artwork-controls.mjs';

for (const kind of ['png', 'mp4'])
  test(
    `F309 ${kind}: real F307 surface and independent cat round return to the original Task`,
    { timeout: 150000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), `f309-review-${kind}-`));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
      await mkdir(evidence, { recursive: true });
      await mediaFixture(root, kind);
      let host, browser, page;
      const errors = [];
      t.after(async () => {
        if (page && !page.isClosed()) {
          await writeFile(
            path.join(evidence, `${kind}-last-state.json`),
            JSON.stringify(
              {
                errors,
                text: await page
                  .locator('body')
                  .innerText()
                  .catch(() => ''),
                url: page.url(),
              },
              null,
              2,
            ),
          );
          await page
            .screenshot({ path: path.join(evidence, `${kind}-last-state.png`), fullPage: true })
            .catch(() => {});
        }
        await browser?.close();
        await host?.close();
        if (evidence !== root) await rm(root, { recursive: true, force: true });
      });
      host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      page.setDefaultTimeout(8000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(host.origin);
      await page.getByTestId('product-schedule-panel').waitFor();
      const preparation = page.waitForResponse(
        (response) =>
          response.url() === `${host.apiOrigin}/api/artifact-reviews/prepare` && response.request().method() === 'POST',
      );
      await page.getByTestId('open-artifact-review').click();
      const prepared = await preparation;
      assert.equal(prepared.status(), 200, await prepared.text());
      await page.getByTestId('artifact-review-surface').waitFor();
      await page
        .getByRole('button', { name: kind === 'png' ? '圈选区域' : '标注整个片段', exact: true })
        .waitFor({ state: 'visible' });
      if (kind === 'png') {
        await page.locator('[data-testid="review-media-stage"] img').waitFor();
        await selectReviewMode(page, 'markup');
        await page.getByTestId('review-markup-layer').waitFor();
        const markupBox = await page.getByTestId('review-markup-layer').boundingBox();
        assert.ok(markupBox);
        const draw = async (tool, from, to) => {
          await selectMarkupTool(page, tool);
          await page.mouse.move(markupBox.x + markupBox.width * from[0], markupBox.y + markupBox.height * from[1]);
          await page.mouse.down();
          await page.mouse.move(markupBox.x + markupBox.width * to[0], markupBox.y + markupBox.height * to[1]);
          await page.mouse.up();
        };
        await selectMarkupColor(page, '#3478c7');
        await draw('画笔', [0.12, 0.18], [0.31, 0.32]);
        await page.getByTestId('review-local-mark').nth(0).waitFor();
        await draw('矩形', [0.38, 0.2], [0.58, 0.42]);
        await page.getByTestId('review-local-mark').nth(1).waitFor();
        await draw('椭圆', [0.62, 0.2], [0.82, 0.42]);
        await page.getByTestId('review-local-mark').nth(2).waitFor();
        await draw('箭头', [0.18, 0.65], [0.42, 0.72]);
        await page.getByTestId('review-local-mark').nth(3).waitFor();
        await page.getByRole('button', { name: '文字', exact: true }).click();
        await page.getByRole('textbox', { name: '标注文字' }).fill('暖一点');
        await page.mouse.click(markupBox.x + markupBox.width * 0.58, markupBox.y + markupBox.height * 0.72);
        await page.getByTestId('review-local-mark').nth(4).waitFor();
        assert.equal(await page.getByTestId('review-local-mark').count(), 5);
        await page.getByRole('button', { name: '撤销', exact: true }).click();
        assert.equal(await page.getByTestId('review-local-mark').count(), 4);
        await page.getByRole('button', { name: '重做', exact: true }).click();
        assert.equal(await page.getByTestId('review-local-mark').count(), 5);
        await page.getByRole('button', { name: '删除', exact: true }).click();
        await page.getByTestId('review-local-mark').first().click();
        assert.equal(await page.getByTestId('review-local-mark').count(), 4);
        await page.screenshot({ path: path.join(evidence, 'png-markup-draft.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: path.join(evidence, 'png-markup-mobile.png'), fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.reload();
        await selectReviewMode(page, 'markup');
        await page.getByTestId('review-local-mark').nth(3).waitFor();
        assert.equal(await page.getByTestId('review-local-mark').count(), 4);
        await selectReviewMode(page, 'comment');
        await page.getByRole('textbox', { name: '新增标注意见' }).waitFor();
        const box = await page.getByTestId('review-media-stage').boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45);
        await page.mouse.up();
        await page.screenshot({ path: path.join(evidence, 'png-comment-mode.png'), fullPage: true });
      } else {
        await page.locator('video').waitFor();
        await page.getByRole('button', { name: '标注整个片段', exact: true }).click();
        await page.getByRole('spinbutton', { name: '片段起点' }).fill('0.4');
        await page.getByRole('spinbutton', { name: '片段终点' }).fill('1.6');
      }
      const sentinel = `这处需要调整，陌生输入-${kind}-九月。`;
      await page.getByRole('textbox', { name: '新增标注意见' }).fill(sentinel);
      await page.reload();
      await page.getByRole('textbox', { name: '新增标注意见' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '新增标注意见' }).inputValue(), sentinel);
      await page.getByRole('button', { name: '保存评论', exact: true }).click();
      await page.getByTestId('review-comment').waitFor();
      const reviewId = host.store.listReviewIds('operator')[0];
      assert.ok(reviewId);
      let view = await host.reviews.read(reviewId, host.human);
      const annotation = view.review.rounds[0].annotations[0];
      assert.equal(annotation.body, sentinel);
      assert.deepEqual(annotation.author, host.human.actor);
      const inspection = await host.catCallback('read', { reviewId, view: 'annotations' });
      assert.ok(inspection.records.some((record) => record.path.endsWith('/body') && record.value === sentinel));
      if (kind === 'png') {
        await page.getByTestId('review-canvas-annotation-mark').click();
        await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'review-comment');
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('data-testid') === 'review-canvas-annotation-mark',
        );
      }
      await host.catCallback('act', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 1,
        round: 1,
        operationId: 'cat-response',
        action: {
          kind: 'reply',
          annotationId: annotation.id,
          replyId: 'named-cat-reply',
          body: '这条批注已读到，我会按这个位置处理。',
        },
      });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await openReviewPanel(page, 'comments');
      await page.getByText('这条批注已读到，我会按这个位置处理。', { exact: true }).waitFor();
      await openReviewPanel(page, 'decision');
      await page.getByRole('textbox', { name: '审阅结论说明' }).fill('请按这条意见提交新一版。');
      await page.getByRole('button', { name: '请猫按意见继续', exact: true }).click();
      await page.getByTestId('review-return-state').waitFor();
      assert.equal(host.store.returns.pending().length, 0);
      view = await host.reviews.read(reviewId, host.cat);
      const name = await mediaFixture(root, kind, 2);
      const publication = host.publish(name);
      await host.catCallback('respond', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 1,
        expectedOwnerRevision: 1,
        operationId: 'new-media-round',
        artifactRef: `/uploads/${name}`,
        expectedArtifactRevision: String(publication.timestamp),
        responses: [
          { annotationId: annotation.id, disposition: 'addressed', explanation: '新版已经针对这条意见做了调整。' },
        ],
      });
      await host.lifecycle.update({
        taskId: host.taskId,
        expectedRevision: 1,
        artifactRefs: [`content:${view.review.contentRef}`],
      });
      view = await host.reviews.read(reviewId, host.cat);
      await host.catCallback('act', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 2,
        round: 2,
        operationId: 'judge-new-version',
        action: {
          kind: 'request_judgment',
          summary: '新一版及逐条回应已准备好',
          judgmentNeeded: '请确认这版是否可以发布。',
        },
      });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('2');
      await openReviewPanel(page, 'details');
      await page.getByText('新版已经针对这条意见做了调整。', { exact: true }).waitFor();
      await selectReviewMode(page, 'comment');
      const input = page.getByRole('textbox', { name: '新增标注意见' });
      await input.fill('新版正在写的意见，不可被重新圈选覆盖');
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('1');
      await openReviewPanel(page, 'comments');
      await page.getByRole('button', { name: '在新版重新圈选', exact: true }).click();
      assert.equal(await input.inputValue(), '新版正在写的意见，不可被重新圈选覆盖');
      await page
        .getByText('新版还有未保存的标注，已为你保留。请先保存或清空这条草稿，再从旧版重新圈选。', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: '清空草稿', exact: true }).click();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('1');
      await openReviewPanel(page, 'comments');
      await page.getByRole('button', { name: '在新版重新圈选', exact: true }).click();
      assert.equal(await input.inputValue(), sentinel);
      await selectReviewMode(page, 'view');
      await page.getByRole('button', { name: kind === 'png' ? '标注整张图片' : '标注整个片段', exact: true }).click();
      await page.getByRole('button', { name: '保存标注', exact: true }).click();
      await page.getByTestId('review-comment').waitFor();
      view = await host.reviews.read(reviewId, host.human);
      assert.deepEqual(view.review.rounds[1].annotations[0].reanchoredFrom, { round: 1, annotationId: annotation.id });
      assert.deepEqual(view.review.rounds[0].annotations[0].anchor, annotation.anchor);
      await page.screenshot({ path: path.join(evidence, `${kind}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: path.join(evidence, `${kind}-mobile.png`), fullPage: true });
      await openReviewPanel(page, 'decision');
      await page.getByRole('textbox', { name: '审阅结论说明' }).fill('这版通过，继续完成原任务的发布。');
      await page.getByRole('button', { name: '这版通过，交还原任务', exact: true }).click();
      await page.getByTestId('review-round-decision').waitFor();
      view = await host.reviews.read(reviewId, host.human);
      assert.equal(view.review.rounds[1].state, 'approved');
      assert.equal(host.tasks.listByKind('work').length, 1);
      assert.equal((await host.ownerReads.listNeedsMeForOwner('operator')).length, 0);
      await page.getByRole('textbox', { name: '审阅结论说明' }).fill('补充核对后再发布');
      await page.getByRole('button', { name: '重新打开这一轮', exact: true }).click();
      await page.getByTestId('review-round-decision').waitFor({ state: 'hidden' });
      view = await host.reviews.read(reviewId, host.human);
      assert.equal(view.review.rounds[1].state, 'draft');
      await host.catCallback('act', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 2,
        round: 2,
        operationId: 'judge-reopened-round',
        action: { kind: 'request_judgment', summary: '已核对补充意见', judgmentNeeded: '请再次确认发布' },
      });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await page.getByRole('textbox', { name: '审阅结论说明' }).fill('再次核对通过，继续发布');
      await page.getByRole('button', { name: '这版通过，交还原任务', exact: true }).click();
      await page.getByTestId('review-round-decision').waitFor();
      view = await host.reviews.read(reviewId, host.human);
      assert.equal(view.review.rounds[1].state, 'approved');
      const task = host.tasks.get(host.taskId);
      await host.lifecycle.close({
        taskId: host.taskId,
        expectedRevision: task.entrustedWork.revision,
        closure: {
          ...task.entrustedWork.closure,
          state: 'satisfied',
          evidenceRefs: [view.review.rounds[1].decision.receiptRef, `message:${host.thread.id}:${publication.id}`],
        },
      });
      await page.getByRole('button', { name: '刷新', exact: true }).first().click();
      await page.getByText('原任务已收口，审阅记录与历史版本继续保留。', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('1');
      await openReviewPanel(page, 'comments');
      await page.getByText(sentinel, { exact: true }).waitFor();
      assert.deepEqual(
        (await host.reviews.mediaBytes(reviewId, 1, host.human)).bytes,
        await readFile(path.join(root, `review-input.${kind}`)),
      );
      assert.deepEqual(errors, []);
      await writeFile(
        path.join(evidence, `${kind}-result.json`),
        JSON.stringify(
          {
            reviewId,
            taskId: host.taskId,
            rounds: view.review.rounds.length,
            human: annotation.author,
            cat: view.review.rounds[0].annotations[0].replies[0].author,
            originalAnchor: annotation.anchor,
            closure: host.tasks.get(host.taskId).entrustedWork.closure,
            errors,
          },
          null,
          2,
        ),
      );
    },
  );
