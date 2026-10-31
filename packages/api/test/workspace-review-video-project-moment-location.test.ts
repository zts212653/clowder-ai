import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewTarget } from '@cat-cafe/shared';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

const hints = [{ segmentId: 'shot-1' }, { visualUseId: 'visual-1' }, { segmentId: 'shot-1', visualUseId: 'visual-1' }];
for (const hint of hints)
  for (const eventStart of [49, 50, 51])
    test(`F326 moment with ${JSON.stringify(hint)} includes only events rendered at tick 50 (start ${eventStart})`, async () => {
      const f = await fixture();
      try {
        f.projects.snapshots.get(1)!.timeline.events.push({
          id: 'subtitle',
          kind: 'subtitle',
          startTick: eventStart,
          durationTicks: 1,
          text: 'Before',
        });
        const reviews = f.service();
        const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Fix this moment',
          target: { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, ...hint },
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        changed.timeline.events[0]!.text = 'After';
        const result = await f.projects.save(changed, 'change-event');
        const address = reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'address',
          action: {
            kind: 'addressed',
            annotationId: marked.review.annotations[0]!.id,
            result,
          },
        });
        if (eventStart === 50) {
          assert.equal((await address).review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
        } else await assert.rejects(address, { code: 'invalid_action' });
      } finally {
        await f.cleanup();
      }
    });

test('F326 changed audio cannot excuse contradictory moment location evidence', async () => {
  const f = await fixture();
  try {
    const base = f.projects.snapshots.get(1)!;
    base.timeline.events.push({ id: 'subtitle', kind: 'subtitle', startTick: 50, text: 'Before' });
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const target: VideoProjectReviewTarget = {
      kind: 'moment',
      tick: 50,
      timebase: { numerator: 1, denominator: 30 },
      segmentId: 'shot-1',
      visualUseId: 'visual-1',
    };
    const marked = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Fix this moment',
      target,
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.timeline.segments[0]!.visuals[0]!.id = 'replacement-use';
    changed.timeline.segments[1]!.visuals[0]!.id = 'visual-1';
    changed.timeline.events[0]!.text = 'After';
    const result = await f.projects.save(changed, 'wrong-location');
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
