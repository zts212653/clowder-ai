import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewResult } from '@cat-cafe/shared';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

for (const resultKind of ['receipt', 'asset'] as const) {
  test(`F326 latest location replaces older targets after reopen/restart (${resultKind})`, async () => {
    const f = await fixture();
    try {
      let reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      let current = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Locate the problem',
        target: { kind: 'project' },
      });
      const original = structuredClone(current.review.annotations[0]!.anchor);
      const annotationId = current.review.annotations[0]!.id;
      const base = await f.projects.load({ principal, contentRef });
      for (const segmentId of ['shot-1', 'shot-2'])
        current = await reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: current.review.revision,
          operationId: `locate-${segmentId}`,
          action: {
            kind: 'located',
            annotationId,
            targets: [
              {
                kind: 'video-project',
                baseOwnerRevision: base.ownerRevision,
                baseRevision: base.blobDigest,
                target: { kind: 'segment', segmentId },
              },
            ],
          },
        });
      current = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: current.review.revision,
        operationId: 'leave-unchanged',
        action: { kind: 'addressed', annotationId, result: { kind: 'not-changed', reason: 'Needs another attempt' } },
      });
      current = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: current.review.revision,
        operationId: 'reopen',
        action: { kind: 'reopened', annotationId, reason: 'Try the located shot' },
      });
      reviews = f.reopen();
      const previousHistory = structuredClone(current.review.annotations[0]!.projectHistory);
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'replacement',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'replacement';
      const wrongReceipt = await f.projects.save(changed, 'wrong-shot');
      const wrong =
        resultKind === 'receipt'
          ? wrongReceipt
          : { assetVersionRef: 'replacement', ownerRevision: wrongReceipt.ownerRevision };
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: current.review.revision,
          operationId: 'wrong-result',
          action: { kind: 'addressed', annotationId, result: wrong },
        }),
        { code: 'invalid_action' },
      );
      assert.equal(
        (await reviews.read({ principal, reviewId: opened.review.reviewId })).review.revision,
        current.review.revision,
      );
      assert.equal(
        await reviews.operationReceipt({ principal, reviewId: opened.review.reviewId, operationId: 'wrong-result' }),
        null,
      );
      changed.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'replacement';
      const receipt = await f.projects.save(changed, 'right-shot');
      const result =
        resultKind === 'receipt' ? receipt : { assetVersionRef: 'replacement', ownerRevision: receipt.ownerRevision };
      const addressed = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: current.review.revision,
        operationId: 'right-result',
        action: { kind: 'addressed', annotationId, result },
      });
      assert.deepEqual(addressed.review.annotations[0]!.anchor, original);
      assert.deepEqual(addressed.review.annotations[0]!.projectHistory!.slice(0, -1), previousHistory);
    } finally {
      await f.cleanup();
    }
  });

  test(`F326 every latest located target must change (${resultKind})`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Fix both shots',
        target: { kind: 'project' },
      });
      const annotationId = marked.review.annotations[0]!.id;
      const base = await f.projects.load({ principal, contentRef });
      const located = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'locate-both',
        action: {
          kind: 'located',
          annotationId,
          targets: ['shot-1', 'shot-2'].map((segmentId) => ({
            kind: 'video-project' as const,
            baseOwnerRevision: base.ownerRevision,
            baseRevision: base.blobDigest,
            target: { kind: 'segment' as const, segmentId },
          })),
        },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'replacement',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'replacement';
      const first = await f.projects.save(changed, 'only-one');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: located.review.revision,
          operationId: 'partial-result',
          action: {
            kind: 'addressed',
            annotationId,
            result:
              resultKind === 'receipt' ? first : { assetVersionRef: 'replacement', ownerRevision: first.ownerRevision },
          },
        }),
        { code: 'invalid_action' },
      );
      changed.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'replacement';
      const both = await f.projects.save(changed, 'both');
      const addressed = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: located.review.revision,
        operationId: 'complete-result',
        action: {
          kind: 'addressed',
          annotationId,
          result:
            resultKind === 'receipt' ? both : { assetVersionRef: 'replacement', ownerRevision: both.ownerRevision },
        },
      });
      assert.equal(addressed.review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
    } finally {
      await f.cleanup();
    }
  });

  test(`F326 location revisions bind a new baseline rather than the original issue (${resultKind})`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Review the revised shot',
        target: { kind: 'project' },
      });
      const annotationId = marked.review.annotations[0]!.id;
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'baseline-v2',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'baseline-v2';
      const baseline = await f.projects.save(changed, 'baseline');
      const located = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'locate-new-baseline',
        action: {
          kind: 'located',
          annotationId,
          targets: [
            {
              kind: 'video-project',
              baseOwnerRevision: baseline.ownerRevision,
              baseRevision: baseline.blobDigest,
              target: { kind: 'segment', segmentId: 'shot-1' },
            },
          ],
        },
      });
      const prove = (result: VideoProjectReviewResult, operationId: string) =>
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: located.review.revision,
          operationId,
          action: { kind: 'addressed', annotationId, result },
        });
      await assert.rejects(
        prove(
          resultKind === 'receipt' ? baseline : { assetVersionRef: 'baseline-v2', ownerRevision: 2 },
          'same-revision',
        ),
        { code: 'invalid_action' },
      );
      changed.title = 'Unrelated metadata';
      const unchanged = await f.projects.save(changed, 'title-only');
      await assert.rejects(
        prove(
          resultKind === 'receipt' ? unchanged : { assetVersionRef: 'baseline-v2', ownerRevision: 3 },
          'same-content',
        ),
        { code: 'invalid_action' },
      );
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'actual-v3',
        sha256: `sha256:${'c'.repeat(64)}`,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'actual-v3';
      const actual = await f.projects.save(changed, 'actual');
      await prove(
        resultKind === 'receipt' ? actual : { assetVersionRef: 'actual-v3', ownerRevision: actual.ownerRevision },
        'changed-content',
      );
    } finally {
      await f.cleanup();
    }
  });
}

test('F326 a segment association cannot hide that a changed event plays outside the target shot', async () => {
  const f = await fixture();
  try {
    f.projects.snapshots.get(1)!.timeline.events.push({
      id: 'later-subtitle',
      kind: 'subtitle',
      segmentId: 'shot-1',
      startTick: 150,
      durationTicks: 20,
      text: 'Old',
    });
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const marked = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Fix first shot',
      target: { kind: 'segment', segmentId: 'shot-1' },
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.timeline.events[0]!.text = 'Changed outside this shot';
    const result = await f.projects.save(changed, 'later');
    await assert.rejects(
      reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'address',
        action: {
          kind: 'addressed',
          annotationId: marked.review.annotations[0]!.id,
          result,
        },
      }),
      { code: 'invalid_action' },
    );
  } finally {
    await f.cleanup();
  }
});
