import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewTarget } from '@cat-cafe/shared';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

const targets: VideoProjectReviewTarget[] = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1' },
  { kind: 'artwork', assetVersionRef: 'image-v1' },
];

test('F326 moving identical artwork to a new locator and spelling zero rotation is still unchanged', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const marked = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Change artwork',
      target: { kind: 'artwork', assetVersionRef: 'image-v1' },
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.assets[0]!.versions.push({
      ...changed.assets[0]!.versions[0]!,
      id: 'relocated-v2',
      rotation: 0,
      locator: { kind: 'workspace', rootId: 'registered-root', path: 'copy.png' },
    });
    changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'relocated-v2';
    const receipt = await f.projects.save(changed, 'relocate');
    for (const [index, result] of [receipt, { assetVersionRef: 'relocated-v2', ownerRevision: 2 }].entries())
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: `location-claim-${index}`,
          action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
        }),
        { code: 'invalid_action' },
      );
  } finally {
    await f.cleanup();
  }
});

for (const target of targets.filter((item) => item.kind === 'segment' || item.kind === 'moment'))
  test(`F326 actual ${target.kind} timing edits are proved by the real owner receipt`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Adjust this timing',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      const shot = changed.timeline.segments[0]!;
      shot.startTick = 1;
      shot.durationTicks = 99;
      shot.visuals[0]!.endTick = 99;
      const result = await f.projects.save(changed, 'timing');
      const addressed = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'timing-result',
        action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
      });
      assert.equal(addressed.review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
    } finally {
      await f.cleanup();
    }
  });

for (const target of targets)
  test(`F326 ${target.kind} cannot claim identical bytes as changed through an asset or owner receipt`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Change this target',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.title = 'Unrelated title';
      changed.assets[0]!.versions.push({ ...changed.assets[0]!.versions[0]!, id: 'duplicate-v2' });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'duplicate-v2';
      const receipt = await f.projects.save(changed, 'duplicate');
      for (const [index, result] of [receipt, { assetVersionRef: 'duplicate-v2', ownerRevision: 2 }].entries())
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: `false-change-${index}`,
            action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
          }),
          { code: 'invalid_action' },
        );
      assert.equal((await reviews.read({ principal, reviewId: opened.review.reviewId })).review.revision, 2);
      await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 2,
        operationId: 'honest-result',
        action: {
          kind: 'addressed',
          annotationId: marked.review.annotations[0]!.id,
          result: { kind: 'not-changed', reason: 'The drawing remains the same.' },
        },
      });
      assert.deepEqual(
        (
          await f.reopen().read({ principal, reviewId: opened.review.reviewId })
        ).review.annotations[0]!.projectHistory!.at(-1)!.result,
        { kind: 'not-changed', reason: 'The drawing remains the same.' },
      );
    } finally {
      await f.cleanup();
    }
  });

for (const target of targets)
  test(`F326 ${target.kind} does not use an unreferenced new asset to prove an addressed target`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Fix this target',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'unused-v2',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.title = 'Metadata only';
      const receipt = await f.projects.save(changed, 'unused-copy');
      for (const [index, result] of [receipt, { assetVersionRef: 'unused-v2', ownerRevision: 2 }].entries())
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: `unused-claim-${index}`,
            action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
          }),
          { code: 'invalid_action' },
        );
    } finally {
      await f.cleanup();
    }
  });

for (const target of targets)
  for (const resultKind of ['asset', 'receipt'])
    for (const material of ['rotation', 'bytes'])
      test(`F326 ${target.kind} accepts actual ${material} changes with ${resultKind} proof`, async () => {
        const f = await fixture();
        try {
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Rotate the drawing',
            target,
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[0]!.versions.push({
            ...changed.assets[0]!.versions[0]!,
            id: 'changed-v2',
            ...(material === 'rotation' ? { rotation: 90 as const } : { sha256: `sha256:${'b'.repeat(64)}` as const }),
          });
          changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'changed-v2';
          const receipt = await f.projects.save(changed, 'rotate');
          const result = resultKind === 'receipt' ? receipt : { assetVersionRef: 'changed-v2', ownerRevision: 2 };
          const addressed = await reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: 'actual-change',
            action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
          });
          assert.equal(addressed.review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
        } finally {
          await f.cleanup();
        }
      });

test('F326 opaque extension bookkeeping cannot assert a project rendering change', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const marked = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Fix the film',
      target: { kind: 'project' },
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.timeline.extensions = [
      { namespace: 'test:provenance', schemaVersion: 1, payload: { importedBy: 'new-name' } },
    ];
    const receipt = await f.projects.save(changed, 'bookkeeping');
    await assert.rejects(
      reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'unknown-render-claim',
        action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result: receipt },
      }),
      { code: 'invalid_action' },
    );
  } finally {
    await f.cleanup();
  }
});

for (const target of targets.filter((item) => item.kind !== 'project'))
  test(`F326 ${target.kind} rejects a receipt changing a different segment`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Fix first shot',
        target: target.kind === 'artwork' ? { ...target, visualUseId: 'visual-1' } : target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'other-shot-v2',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'other-shot-v2';
      const receipt = await f.projects.save(changed, 'other-shot');
      for (const [index, result] of [receipt, { assetVersionRef: 'other-shot-v2', ownerRevision: 2 }].entries())
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: `wrong-target-${index}`,
            action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
          }),
          { code: 'invalid_action' },
        );
    } finally {
      await f.cleanup();
    }
  });

for (const target of targets.filter((item) => item.kind !== 'project'))
  test(`F326 orphaned ${target.kind} cannot claim an unrelated replacement as changed`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Keep the target traceable',
        target: target.kind === 'artwork' ? { ...target, visualUseId: 'visual-1' } : target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.timeline.segments.shift();
      const receipt = await f.projects.save(changed, 'erase-target');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'lost-target',
          action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result: receipt },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });
