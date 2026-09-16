import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { selectReviewMode } from './fixtures/f309-artwork-controls.mjs';

for (const kind of ['png', 'mp4']) {
  test(
    `F309 ${kind}: real Needs Me and Schedule entries preserve their exact return after reload`,
    { timeout: 150000 },
    async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), `f309-needs-me-${kind}-`));
      const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
      await mkdir(evidence, { recursive: true });
      await mediaFixture(root, kind);
      let host, browser, page;
      const errors = [];
      t.after(async () => {
        if (page && !page.isClosed()) {
          await writeFile(
            path.join(evidence, `${kind}-needs-me-state.json`),
            JSON.stringify(
              {
                errors,
                url: page.url(),
                text: await page.locator('body').innerText(),
                retainedReviewContainers: await page.getByTestId('artifact-review-surface').count(),
                visibleReviews: await page.locator('[data-testid="artifact-review-surface"]:visible').count(),
                mediaStages: await page.getByTestId('review-media-stage').count(),
                reviewDraftKeys: await page.evaluate(() =>
                  Object.keys(localStorage).filter((key) => key.startsWith('cat-cafe:review:')),
                ),
              },
              null,
              2,
            ),
          );
          await page.screenshot({ path: path.join(evidence, `${kind}-needs-me-final.png`), fullPage: true });
        }
        await browser?.close();
        await host?.close();
        if (evidence !== root) await rm(root, { recursive: true, force: true });
      });
      host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
      const prepared = await host.catCallback('prepare', host.prepare);
      const reviewId = prepared.reviewId;
      assert.match(reviewId, /^review-[a-f0-9]{64}$/);
      await writeFile(path.join(evidence, `${kind}-needs-me-receipt.json`), JSON.stringify(prepared, null, 2));
      await host.catCallback('act', {
        reviewId,
        expectedRevision: prepared.revision,
        expectedTaskRevision: 1,
        round: 1,
        operationId: `needs-me-judgment-${kind}`,
        action: { kind: 'request_judgment', summary: '这份产物已准备好', judgmentNeeded: '请确认是否继续发布' },
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      page.setDefaultTimeout(10000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(host.origin);
      await page.getByTestId('product-schedule-panel').waitFor();
      await page.getByTestId('f307-add-surface').click();
      await page.getByTestId('workspace-launcher-needs-me').click();
      const needsMe = page.getByTestId('needs-me-panel');
      const row = needsMe.getByTestId('needs-me-item');
      await row.waitFor();
      const needsMeItemRef = await row.getAttribute('data-item-ref');
      assert.equal(await row.getAttribute('data-task-subject-ref'), `task:work:${host.taskId}`);
      assert.equal(await row.getAttribute('data-producer-id'), 'f309.content_review');
      await row.getByTestId('needs-me-open-action').click();
      await selectReviewMode(page, 'comment');
      const draft = page.getByRole('textbox', { name: '新增标注意见' });
      await draft.waitFor();
      await draft.fill(`Needs Me 入口保留的陌生意见 · ${kind}`);
      await page.reload();
      await draft.waitFor();
      assert.equal(await draft.inputValue(), `Needs Me 入口保留的陌生意见 · ${kind}`);
      assert.equal(await page.getByTestId('artifact-review-surface').count(), 1);
      await page.getByTestId('f307-close-review').click();
      await row.waitFor();
      assert.equal(await row.getAttribute('data-item-ref'), needsMeItemRef);
      assert.equal(await row.getAttribute('data-selected'), 'true');

      await row.getByTestId('open-artifact-review').click();
      await draft.waitFor();
      assert.equal(await draft.inputValue(), `Needs Me 入口保留的陌生意见 · ${kind}`);
      await page.getByRole('button', { name: '← 回到原处', exact: true }).click();
      await row.waitFor();
      await page.getByTestId('f307-add-surface').click();
      await page.getByTestId('workspace-launcher-product-schedule').click();
      const schedule = page.getByTestId('product-schedule-panel');
      const scheduleRow = schedule.locator(`[data-subject-ref="task:work:${host.taskId}"]`);
      await scheduleRow.waitFor();
      const scheduleItemRef = await scheduleRow.getAttribute('data-item-ref');
      await scheduleRow.getByTestId('open-artifact-review').click();
      await draft.waitFor();
      assert.equal(await draft.inputValue(), `Needs Me 入口保留的陌生意见 · ${kind}`);
      await page.reload();
      await draft.waitFor();
      await page.getByTestId('f307-close-review').click();
      await scheduleRow.waitFor();
      assert.equal(await scheduleRow.getAttribute('data-item-ref'), scheduleItemRef);
      assert.equal(await scheduleRow.getAttribute('data-selected'), 'true');
      await page.screenshot({ path: path.join(evidence, `${kind}-needs-me-schedule-return.png`), fullPage: true });

      await page.getByTestId('f307-add-surface').click();
      await page.getByTestId('workspace-launcher-needs-me').click();
      await row.waitFor();
      const beforeDeniedRead = host.store.get(reviewId);
      const auditBeforeDeniedRead = host.store.history(reviewId);
      await host.messages.softDelete(host.publication.id, 'operator');
      await row.getByTestId('needs-me-open-action').click();
      await page.getByRole('alert').filter({ hasText: '这份内容已更新或暂时不可用，请刷新后再试。' }).waitFor();
      await row.waitFor({ state: 'detached', timeout: 2500 });
      await page.getByTestId('review-media-stage').waitFor({ state: 'detached', timeout: 2500 });
      // F307 deliberately retains recently closed owner containers; authorization must remove their contents.
      assert.equal(await page.locator('[data-testid="artifact-review-surface"]:visible').count(), 0);
      assert.ok((await page.getByTestId('artifact-review-surface').count()) <= 1);
      assert.equal(await page.getByTestId('review-media-stage').count(), 0);
      assert.equal(await page.locator('textarea[aria-label="新增标注意见"]').count(), 0);
      assert.equal(await needsMe.getByTestId('prepared-artifact-preview').count(), 0);
      assert.deepEqual(
        await page.evaluate(
          (id) => Object.keys(localStorage).filter((key) => key.startsWith(`cat-cafe:review:operator:${id}:`)),
          reviewId,
        ),
        [],
      );
      assert.deepEqual(host.store.get(reviewId), beforeDeniedRead, 'read-only denial cannot mutate the review ledger');
      assert.deepEqual(host.store.history(reviewId), auditBeforeDeniedRead);
      await host.recoverySpec.run.execute({});
      assert.equal(host.store.get(reviewId).rounds[0].attentionRetiredReason, 'access_revoked');
      assert.equal(host.store.get(reviewId).rounds[0].decision, undefined);
      assert.notEqual((await host.tasks.get(host.taskId)).status, 'done');
      assert.equal(host.starts.length, 0);
      assert.deepEqual(errors, []);
    },
  );
}
