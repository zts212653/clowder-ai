import { describe, expect, it } from 'vitest';
import {
  createArtifactReviewSurface,
  resolveArtifactReviewTarget,
} from '@/components/workbench/artifact-review-surface';
import {
  createNeedsMeReturnSurface,
  createProductScheduleReturnSurface,
  createWorkspaceModeSurface,
  resolveNeedsMeReturnTarget,
  resolveProductScheduleReturnTarget,
} from '@/components/workbench/real-surface-adapters';
import {
  createInitialWorkbenchState,
  reduceWorkbench,
  restoreWorkbenchState,
} from '@/components/workbench/workbench-model';

const USER = { kind: 'user', reason: 'surface-tab' } as const;
const REVIEW_ID = `review-${'a'.repeat(64)}`;
const REVIEW = createArtifactReviewSurface(REVIEW_ID, 'thread-review-owner', '同一份审阅');
const OTHER_REVIEW = createArtifactReviewSurface(`review-${'b'.repeat(64)}`, 'thread-other-review-owner', '另一份审阅');
const SCHEDULE = createWorkspaceModeSurface('product-schedule', 'thread-schedule-source');
const NEEDS_ME = createWorkspaceModeSurface('needs-me', 'thread-needs-me-source');
const scheduleReturn = createProductScheduleReturnSurface(SCHEDULE, 'schedule:task-one');
const needsMeReturn = createNeedsMeReturnSurface(NEEDS_ME, 'needs-me:task-one:review');
if (!scheduleReturn || !needsMeReturn) throw new Error('Valid owner return coordinates must be admitted');

describe.each(['desktop', 'mobile'] as const)('review source continuity: %s', (presentation) => {
  it('ordinary close after reload restores the exact originating Task row', () => {
    let state = reduceWorkbench(createInitialWorkbenchState([SCHEDULE]), {
      type: 'open-artifact-with-return',
      artifact: REVIEW,
      returnSurface: scheduleReturn,
      presentation,
      entitlement: USER,
    });
    const reviewSurfaceId = state.activeSurfaceId;
    expect(reviewSurfaceId).not.toBeNull();
    if (reviewSurfaceId === null) throw new Error('The review must be active after opening');
    state = restoreWorkbenchState(JSON.parse(JSON.stringify(state)));
    const restoredReview = state.surfaces.find((surface) => surface.id === reviewSurfaceId);
    expect(restoredReview && resolveArtifactReviewTarget(restoredReview)).toEqual({
      reviewId: REVIEW_ID,
      threadId: 'thread-review-owner',
    });
    state = reduceWorkbench(state, {
      type: 'close-surface',
      surfaceId: reviewSurfaceId,
      entitlement: USER,
    });
    const returned = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(returned && resolveProductScheduleReturnTarget(returned)).toEqual({
      threadId: 'thread-schedule-source',
      itemRef: 'schedule:task-one',
    });
  });

  it('different reviews retain their own source through reload and close', () => {
    let state = reduceWorkbench(createInitialWorkbenchState([SCHEDULE, NEEDS_ME]), {
      type: 'open-artifact-with-return',
      artifact: REVIEW,
      returnSurface: scheduleReturn,
      presentation,
      entitlement: USER,
    });
    const scheduleReviewId = state.activeSurfaceId;
    if (scheduleReviewId === null) throw new Error('The Schedule review must be active after opening');
    state = reduceWorkbench(state, {
      type: 'open-artifact-with-return',
      artifact: OTHER_REVIEW,
      returnSurface: needsMeReturn,
      presentation,
      entitlement: USER,
    });
    const needsMeReviewId = state.activeSurfaceId;
    expect(needsMeReviewId).not.toBe(scheduleReviewId);
    if (needsMeReviewId === null) throw new Error('The Needs Me review must be active after opening');
    state = restoreWorkbenchState(JSON.parse(JSON.stringify(state)));
    const reviews = state.surfaces.filter((surface) => surface.type === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews.map(resolveArtifactReviewTarget)).toEqual([
      { reviewId: REVIEW_ID, threadId: 'thread-review-owner' },
      { reviewId: OTHER_REVIEW.objectRef.id, threadId: 'thread-other-review-owner' },
    ]);

    state = reduceWorkbench(state, { type: 'activate-surface', surfaceId: scheduleReviewId, entitlement: USER });

    state = reduceWorkbench(state, {
      type: 'close-artifact-to-return',
      artifactSurfaceId: scheduleReviewId,
      entitlement: USER,
    });
    const schedule = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(schedule && resolveProductScheduleReturnTarget(schedule)).toEqual({
      threadId: 'thread-schedule-source',
      itemRef: 'schedule:task-one',
    });
    expect(state.surfaces.some((surface) => surface.id === needsMeReviewId)).toBe(true);

    state = reduceWorkbench(state, { type: 'activate-surface', surfaceId: needsMeReviewId, entitlement: USER });
    state = reduceWorkbench(state, {
      type: 'close-surface',
      surfaceId: needsMeReviewId,
      entitlement: USER,
    });
    const needsMe = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(needsMe && resolveNeedsMeReturnTarget(needsMe)).toEqual({
      threadId: 'thread-needs-me-source',
      itemRef: 'needs-me:task-one:review',
    });
  });

  it('reopening one canonical review from another entry updates its one Host binding', () => {
    let state = reduceWorkbench(createInitialWorkbenchState([SCHEDULE, NEEDS_ME]), {
      type: 'open-artifact-with-return',
      artifact: REVIEW,
      returnSurface: scheduleReturn,
      presentation,
      entitlement: USER,
    });
    state = reduceWorkbench(state, {
      type: 'open-artifact-with-return',
      artifact: REVIEW,
      returnSurface: needsMeReturn,
      presentation,
      entitlement: USER,
    });
    state = restoreWorkbenchState(JSON.parse(JSON.stringify(state)));
    expect(state.surfaces.filter((surface) => surface.type === 'review')).toHaveLength(1);
    state = reduceWorkbench(state, { type: 'close-surface', surfaceId: REVIEW.id, entitlement: USER });
    const returned = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
    expect(returned && resolveNeedsMeReturnTarget(returned)).toEqual({
      threadId: 'thread-needs-me-source',
      itemRef: 'needs-me:task-one:review',
    });
  });
});
