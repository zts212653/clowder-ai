import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { startReviewHost } from './fixtures/f309-artifact-review-host.mjs';
import { mediaFixture } from './fixtures/f309-artifact-review-media.mjs';
import { openReviewPanel } from './fixtures/f309-artwork-controls.mjs';

async function setup(t, name, kind = 'png') {
  const root = await mkdtemp(path.join(tmpdir(), `f309-passive-${name}-`));
  const evidence = process.env.F309_BROWSER_EVIDENCE_DIR ?? root;
  await mkdir(evidence, { recursive: true });
  await mediaFixture(root, kind);
  const host = await startReviewHost(root, kind === 'png' ? 'image/png' : 'video/mp4');
  const browser = await chromium.launch({ headless: true });
  const pages = [];
  const errors = [];
  t.after(async () => {
    for (const [index, page] of pages.entries()) {
      await page.screenshot({ path: path.join(evidence, `${name}-${index}.png`) });
      await writeFile(path.join(evidence, `${name}-${index}.txt`), await page.locator('body').innerText());
    }
    await writeFile(
      path.join(evidence, `${name}-result.json`),
      JSON.stringify({ errors, task: host.tasks.get(host.taskId), review: host.store.get(reviewId) }, null, 2),
    );
    await browser.close();
    await host.close();
    if (root !== evidence) await rm(root, { recursive: true, force: true });
  });
  const prepared = await host.reviews.prepare(host.prepare, host.human);
  const reviewId = prepared.review.reviewId;
  await host.catCallback('act', {
    reviewId,
    expectedRevision: prepared.review.revision,
    expectedTaskRevision: 1,
    round: 1,
    operationId: `judge-${name}`,
    action: { kind: 'request_judgment', summary: '封面准备好', judgmentNeeded: '请确认发布' },
  });
  async function open(mode) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    pages.push(page);
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(`${host.origin}?mode=${mode}`);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="review-host-socket"]')?.getAttribute('data-connected') === 'true',
    );
    return page;
  }
  return { host, reviewId, open, errors, root };
}

test(
  'open Schedule, Needs Me and review history react passively to typed Task update/closure',
  { timeout: 150000 },
  async (t) => {
    const { host, reviewId, open, errors } = await setup(t, 'task-events');
    const schedule = await open('product-schedule');
    const needs = await open('needs-me');
    await schedule.getByTestId('product-schedule-item').waitFor();
    await needs.getByTestId('needs-me-item').waitFor();
    const history = await open('product-schedule');
    await history.getByTestId('open-artifact-review').click();
    await history.getByTestId('artifact-review-surface').waitFor();
    await host.taskCallback('update-entrusted-work', { taskId: host.taskId, expectedRevision: 1, status: 'doing' });
    // No clicks, focus changes, reloads or synthetic DOM invalidation after the owner action.
    await needs.getByTestId('needs-me-item').waitFor({ state: 'hidden' });
    await schedule.waitForFunction(
      () =>
        document.querySelector('[data-testid="product-schedule-item"]')?.getAttribute('data-owner-revision') === '2',
    );
    const task = host.tasks.get(host.taskId);
    await host.taskCallback('close-entrusted-work', {
      taskId: host.taskId,
      expectedRevision: 2,
      closure: {
        ...task.entrustedWork.closure,
        state: 'satisfied',
        evidenceRefs: [`message:${host.thread.id}:${host.publication.id}`],
      },
    });
    await schedule.getByTestId('product-schedule-item').waitFor({ state: 'hidden' });
    await history.getByText('原任务已收口，审阅记录与历史版本继续保留。', { exact: true }).waitFor();
    await history.getByTestId('review-media-stage').waitFor();
    assert.equal((await host.reviews.read(reviewId, host.human)).review.rounds.length, 1);
    assert.deepEqual(errors, []);
  },
);

for (const kind of ['png', 'mp4']) {
  test(
    `closed ${kind} review reopens from its original Artifact in a fresh browser`,
    { timeout: 150000 },
    async (t) => {
      const { host, reviewId, open, errors, root } = await setup(t, `closed-artifact-${kind}`, kind);
      const retainedComment = `${kind} 已完成任务中的原始审阅意见`;
      let view = await host.reviews.read(reviewId, host.human);
      const media = view.review.rounds[0].asset.media;
      view = (
        await host.reviews.act(
          {
            reviewId,
            expectedRevision: view.review.revision,
            expectedTaskRevision: 1,
            round: 1,
            operationId: 'retained-comment',
            action: {
              kind: 'annotate',
              annotationId: 'retained-comment',
              anchor:
                kind === 'png'
                  ? { kind: 'image-region', x: 10, y: 10, width: 40, height: 30 }
                  : { kind: 'video-range', streamId: media.streamId, startTick: 0, endTick: media.durationTicks },
              body: retainedComment,
            },
          },
          host.human,
        )
      ).view;
      view = (
        await host.reviews.act(
          {
            reviewId,
            expectedRevision: view.review.revision,
            expectedTaskRevision: 1,
            round: 1,
            operationId: 'retained-feedback',
            action: { kind: 'submit_feedback', explanation: '请按原始意见修改。' },
          },
          host.human,
        )
      ).view;
      const name = await mediaFixture(root, kind, 2);
      const publication = host.publish(name);
      await host.catCallback('respond', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 1,
        expectedOwnerRevision: 1,
        operationId: 'retained-new-version',
        artifactRef: `/uploads/${name}`,
        expectedArtifactRevision: String(publication.timestamp),
        responses: [
          { annotationId: 'retained-comment', disposition: 'addressed', explanation: '新版已响应原始意见。' },
        ],
      });
      await host.taskCallback('update-entrusted-work', {
        taskId: host.taskId,
        expectedRevision: 1,
        artifactRefs: [`content:${view.review.contentRef}`],
      });
      view = await host.reviews.read(reviewId, host.human);
      await host.catCallback('act', {
        reviewId,
        expectedRevision: view.review.revision,
        expectedTaskRevision: 2,
        round: 2,
        operationId: 'retained-new-judgment',
        action: { kind: 'request_judgment', summary: '新版已准备好', judgmentNeeded: '请确认新版' },
      });
      view = await host.reviews.read(reviewId, host.human);
      view = (
        await host.reviews.act(
          {
            reviewId,
            expectedRevision: view.review.revision,
            expectedTaskRevision: 2,
            round: 2,
            operationId: 'retained-approval',
            action: { kind: 'decide', outcome: 'approved', explanation: '新版通过，保留审阅历史。' },
          },
          host.human,
        )
      ).view;
      assert.equal(view.review.rounds.length, 2);
      await host.recoverySpec.run.execute({});
      assert.equal((await host.reviews.read(reviewId, host.human)).continuation.returnDelivery?.state, 'queued');
      const task = host.tasks.get(host.taskId);
      await host.taskCallback('close-entrusted-work', {
        taskId: host.taskId,
        expectedRevision: 2,
        closure: {
          ...task.entrustedWork.closure,
          state: 'satisfied',
          evidenceRefs: [view.continuation.reviewEvidenceRef],
        },
      });

      const page = await open('product-schedule');
      await page.getByTestId('f307-add-surface').click();
      await page.getByTestId('workspace-launcher-artifacts').click();
      await page
        .locator('[data-artifact-row]')
        .filter({ has: page.locator(`a[href$="/uploads/review-input.${kind}"]`) })
        .click();
      await page.getByTestId('open-artifact-review').click();
      await page.getByText('原任务已收口，审阅记录与历史版本继续保留。', { exact: true }).waitFor();
      await openReviewPanel(page, 'details');
      await page.getByText('新版已响应原始意见。', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('1');
      await openReviewPanel(page, 'comments');
      await page.getByText(retainedComment, { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '新增标注意见', exact: true }).count(), 0);
      await page.reload();
      await page.getByText('原任务已收口，审阅记录与历史版本继续保留。', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: '审阅版本' }).selectOption('1');
      await openReviewPanel(page, 'comments');
      await page.getByText(retainedComment, { exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByTestId('review-media-stage').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(host.tasks.get(host.taskId).status, 'done');
      assert.deepEqual((await host.reviews.read(reviewId, host.human)).review, view.review);
      assert.deepEqual(errors, []);
    },
  );
}

test(
  'background producer retirement reaches the mounted owner surfaces over user-scoped Socket.IO',
  { timeout: 150000 },
  async (t) => {
    const { host, reviewId, open, errors } = await setup(t, 'retirement-events');
    const schedule = await open('product-schedule');
    const needs = await open('needs-me');
    await schedule.getByTestId('product-schedule-item').waitFor();
    await needs.getByTestId('needs-me-item').waitFor();
    let reads = 0;
    for (const page of [schedule, needs])
      page.on('request', (request) => {
        if (request.url().includes('/api/entrusted-work/')) reads += 1;
      });
    const before = host.store.get(reviewId);
    await host.messages.softDelete(host.publication.id, 'operator'); // Withdraw the source without a review-route/browser mutation.
    host.emitToUser('another-owner', 'entrusted_work_projection_invalidated', { ownerUserId: 'another-owner' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(reads, 0, 'foreign owner events must not enter the subscribed user room');
    assert.equal(await needs.getByTestId('needs-me-item').count(), 1);
    await host.recoverySpec.run.execute({});
    await needs.getByTestId('needs-me-item').waitFor({ state: 'hidden' });
    await schedule.getByText('安静进行中', { exact: true }).waitFor();
    assert.ok(reads >= 2, 'both already-mounted owner projections must refetch from the producer event');
    assert.equal(host.store.get(reviewId).revision, before.revision + 1);
    assert.equal(host.store.get(reviewId).rounds.at(-1).attentionRetiredReason, 'access_revoked');
    assert.deepEqual(errors, []);
  },
);
