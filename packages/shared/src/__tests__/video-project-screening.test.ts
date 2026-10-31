import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as video from '../types/video-project.js';
import { videoProjectReviewAnchorSchema, videoProjectReviewTargetSchema } from '../types/video-project-review.js';
import { actor, digest, origin, project } from './video-project.fixtures.js';
import { screening } from './video-project-screening.fixtures.js';

describe('frozen project screening contract', () => {
  it('keeps optional Phase B facts absent on Phase A inputs', () => {
    expect(video.videoProjectDocumentSchema.parse(project())).toEqual(project());
  });
  it('retains the exact frozen input, media, and registration provenance', () => {
    expect(video.videoProjectScreeningSchema.parse(screening())).toEqual(screening());
    const value = { ...project(), screenings: [screening()] };
    expect(video.videoProjectDocumentSchema.parse(value)).toEqual(value);
  });
  it('rejects duplicate screening identities and registration operations', () => {
    const first = screening();
    for (const second of [first, { ...first, id: 'another' }]) {
      expect(video.videoProjectDocumentSchema.safeParse({ ...project(), screenings: [first, second] }).success).toBe(
        false,
      );
    }
  });
  it('retains an explicitly unmapped ending without inventing project frames', () => {
    expect(video.mediaPtsToProjectTick(screening(), 51200)).toBe(null);
    expect(video.mediaPtsToProjectTick(screening(), 60000)).toBe(null);
    expect(video.projectTickToMediaPts(screening(), 100)).toBe(null);
  });
  it('converts C08c frames by exact media ticks rather than the shot start', () => {
    const value = screening();
    value.media.media.durationTicks = 7_556_290;
    value.mapping.segments = [
      { mediaStartPts: 0, mediaEndPts: 6_062_592, projectStartTick: 0, projectEndTick: 11841, refs: ['render:1'] },
    ];
    expect(video.projectTickToMediaPts(value, 1429)).toBe(731648);
    expect(video.mediaPtsToProjectTick(value, 731648)).toBe(1429);
  });
  it('handles trim and variable speed with explicit floor/ceil and signed PTS', () => {
    const value = screening();
    value.media.media.startTick = -50;
    value.mapping.segments = [
      { mediaStartPts: -50, mediaEndPts: 50, projectStartTick: 10, projectEndTick: 13, refs: ['source:1'] },
    ];
    expect(video.mediaPtsToProjectTick(value, -1)).toBe(11);
    expect(video.mediaPtsToProjectTick(value, -1, 'ceil')).toBe(12);
    expect(video.projectTickToMediaPts(value, 11)).toBe(-17);
    expect(video.projectTickToMediaPts(value, 11, 'ceil')).toBe(-16);
  });
  it('uses exact arithmetic for products larger than safe Number precision', () => {
    const value = screening();
    const end = Number.MAX_SAFE_INTEGER;
    value.media.media.durationTicks = end;
    value.mapping.segments = [
      { mediaStartPts: 0, mediaEndPts: end, projectStartTick: 0, projectEndTick: end - 1, refs: ['source:1'] },
    ];
    expect(video.mediaPtsToProjectTick(value, end - 1)).toBe(end - 2);
    expect(video.mediaPtsToProjectTick(value, end - 1, 'ceil')).toBe(end - 1);
  });
  it('maps a complete half-open selection with floor start and ceil end', () => {
    expect(video.mapScreeningMediaRange(screening(), { startPts: 1, endPts: 51200 })).toEqual({
      startTick: 0,
      endTick: 100,
    });
  });
  it('joins adjacent mapping pieces only when both input and media are continuous', () => {
    const value = screening();
    value.mapping.segments = [
      { mediaStartPts: 0, mediaEndPts: 100, projectStartTick: 0, projectEndTick: 10, refs: ['source:1'] },
      { mediaStartPts: 100, mediaEndPts: 200, projectStartTick: 10, projectEndTick: 30, refs: ['source:2'] },
    ];
    expect(video.mapScreeningMediaRange(value, { startPts: 50, endPts: 150 })).toEqual({ startTick: 5, endTick: 20 });
    value.mapping.segments[1].projectStartTick = 11;
    expect(video.mapScreeningMediaRange(value, { startPts: 50, endPts: 150 })).toBe(null);
    value.mapping.segments[1].projectStartTick = 10;
    value.mapping.segments[1].mediaStartPts = 101;
    expect(video.mapScreeningMediaRange(value, { startPts: 50, endPts: 150 })).toBe(null);
  });
  it('accepts individually monotone reordered pieces without inventing a continuous target', () => {
    const value = screening();
    value.mapping.segments = [
      { mediaStartPts: 0, mediaEndPts: 100, projectStartTick: 100, projectEndTick: 120, refs: ['source:1'] },
      { mediaStartPts: 100, mediaEndPts: 200, projectStartTick: 10, projectEndTick: 30, refs: ['source:2'] },
    ];
    expect(video.videoProjectScreeningSchema.parse(value)).toEqual(value);
    expect(video.mediaPtsToProjectTick(value, 150)).toBe(20);
    expect(video.projectTickToMediaPts(value, 20)).toBe(150);
    expect(video.mapScreeningMediaRange(value, { startPts: 50, endPts: 150 })).toBe(null);
  });
  it('does not truncate a selection partly inside the unmapped ending', () => {
    expect(video.mapScreeningMediaRange(screening(), { startPts: 50000, endPts: 60000 })).toBe(null);
    expect(video.mapScreeningMediaRange(screening(), { startPts: 50, endPts: 50 })).toBe(null);
  });
  it.each(['media', 'project'] as const)('rejects overlapping or backwards %s mapping', (coordinate) => {
    const value = screening();
    value.mapping.segments.push({
      mediaStartPts: 51200,
      mediaEndPts: 60000,
      projectStartTick: 100,
      projectEndTick: 120,
      refs: ['source:2'],
    });
    if (coordinate === 'media') value.mapping.segments[1].mediaStartPts = 51199;
    else value.mapping.segments[1].projectStartTick = 99;
    expect(video.videoProjectScreeningSchema.safeParse(value).success).toBe(false);
  });
  it('rejects out-of-probe bounds, unsafe integer endpoints and image streams', () => {
    const value = screening();
    expect(
      video.videoProjectScreeningSchema.safeParse({
        ...value,
        media: { ...value.media, media: { kind: 'image', width: 1280, height: 720 } },
      }).success,
    ).toBe(false);
    for (const mediaEndPts of [61441, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
      const segments = [{ ...value.mapping.segments[0], mediaEndPts }];
      expect(
        video.videoProjectScreeningSchema.safeParse({ ...value, mapping: { ...value.mapping, segments } }).success,
      ).toBe(false);
    }
  });
  it('does not bind historical screening dimensions to a subsequently edited head', () => {
    const previous = project();
    const value = {
      ...previous,
      timeline: { ...previous.timeline, width: 1080, height: 1920 },
      screenings: [screening()],
    };
    expect(video.videoProjectDocumentSchema.parse(value)).toEqual(value);
  });
});

describe('self-review facts and moment selections', () => {
  it('accepts actual Cat provenance for a historical input, never inferred Human approval', () => {
    const review = {
      id: 'review-1',
      input: { contentRef: 'project-1', ownerRevision: 1, blobDigest: digest },
      actor: { kind: 'cat' as const, actorId: 'reviewer' },
      at: origin.at,
      operationId: 'attest-1',
      segmentIds: ['shot-1'],
      conclusion: 'pass' as const,
      refs: ['message:review-1'],
    };
    expect(video.videoProjectSelfReviewSchema.parse(review)).toEqual(review);
    expect(video.videoProjectDocumentSchema.parse({ ...project(), selfReviews: [review] }).selfReviews).toEqual([
      review,
    ]);
    expect(video.videoProjectSelfReviewSchema.safeParse({ ...review, actor }).success).toBe(false);
    expect(video.videoProjectSelfReviewSchema.safeParse({ ...review, refs: [] }).success).toBe(false);
    expect(video.videoProjectSelfReviewSchema.safeParse({ ...review, segmentIds: ['shot-1', 'shot-1'] }).success).toBe(
      false,
    );
  });
  it('preserves a same-timebase nonempty moment range in target and anchor', () => {
    const target = { kind: 'moment' as const, tick: 10, endTick: 50, timebase: { numerator: 1, denominator: 30 } };
    expect(videoProjectReviewTargetSchema.parse(target)).toEqual(target);
    expect(
      videoProjectReviewAnchorSchema.parse({
        kind: 'video-project',
        baseRevision: digest,
        baseOwnerRevision: 1,
        target,
      }).target,
    ).toEqual(target);
    const union = z.discriminatedUnion('kind', [
      videoProjectReviewAnchorSchema,
      z.object({ kind: z.literal('other') }).strict(),
    ]);
    expect(union.parse({ kind: 'video-project', baseRevision: digest, baseOwnerRevision: 1, target }).kind).toBe(
      'video-project',
    );
  });
  it.each([0, 10, 9, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid endTick %s', (endTick) => {
    expect(
      videoProjectReviewTargetSchema.safeParse({
        kind: 'moment',
        tick: 10,
        endTick,
        timebase: { numerator: 1, denominator: 30 },
      }).success,
    ).toBe(false);
  });
});
