import { isDeepStrictEqual } from 'node:util';
import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../errors.js';
import { assertProjectReviewTarget } from '../video-project-review-anchors.js';
import {
  type ProjectReviewEvidence as Evidence,
  materialUseChanged,
  type ProjectReviewUsage as Usage,
  unchangedIdentityPermutation,
} from './correspondence.js';

import { assetMaterial } from './material.js';
import { momentRangeEvidence } from './moment-range.js';

type Document = VideoProjectDocumentV1;
type Segment = Document['timeline']['segments'][number];
type Visual = Segment['visuals'][number];
type Event = Document['timeline']['events'][number];

/** Only generic render inputs prove a change; IDs, file locators and opaque bookkeeping do not. */
export function assertProjectTargetChanged(
  before: Document,
  after: Document,
  target: VideoProjectReviewTarget,
  assetVersionRef?: string,
): void {
  const original = projectTargetEvidence(before, before, target);
  const result = projectTargetEvidence(after, before, target);
  if (!original || !result || isDeepStrictEqual(original.value, result.value)) invalid();
  if (target.kind === 'segment' && !segmentAppliedChanged(before, after, target.segmentId)) invalid();
  if (!assetVersionRef && target.kind !== 'artwork') return;
  const prior = target.kind === 'moment' ? original : projectTargetEvidence(before, before, { kind: 'project' });
  const applied = target.kind === 'moment' ? result : projectTargetEvidence(after, before, { kind: 'project' });
  if (!prior || !applied) invalid();
  const ranges =
    target.kind === 'segment'
      ? [before, after].flatMap((document) =>
          document.timeline.segments
            .filter((segment) => segment.id === target.segmentId)
            .map((segment) => ({ startTick: segment.startTick, endTick: segment.startTick + segment.durationTicks })),
        )
      : undefined;
  // Stable IDs map objects; complete target inputs independently prove the modification.
  if (
    !result.usages.some(
      (use) =>
        (!assetVersionRef || use.assetVersionRef === assetVersionRef) &&
        materialUseChanged(prior, applied, use, target.kind === 'artwork', ranges),
    )
  )
    invalid();
}

function segmentAppliedChanged(before: Document, after: Document, id: string): boolean {
  const identity = (document: Document) =>
    document.timeline.segments.map((segment) => ({
      key: segment.id,
      value: {
        kind: segment.kind,
        sceneId: segment.sceneId,
        label: segment.label,
        visualIds: segment.visuals.map((visual) => visual.id),
      },
    }));
  if (unchangedIdentityPermutation(identity(before), identity(after), id)) return false;
  const ranges = [before, after].map((document) => document.timeline.segments.find((segment) => segment.id === id));
  if (ranges.some((segment) => !segment)) return false;
  const projection = (document: Document) => ({
    canvas: canvas(document),
    segments: document.timeline.segments
      .filter((segment) =>
        ranges.some(
          (range) =>
            range &&
            segment.startTick < range.startTick + range.durationTicks &&
            segment.startTick + segment.durationTicks > range.startTick,
        ),
      )
      .map((segment) => segmentEvidence(document, segment)),
    events: document.timeline.events
      .filter((event) => ranges.some((range) => range && eventInSegment(event, range)))
      .map((event) => eventEvidence(document, event)),
  });
  return !isDeepStrictEqual(projection(before), projection(after));
}

function projectTargetEvidence(
  document: Document,
  original: Document,
  target: VideoProjectReviewTarget,
): Evidence | undefined {
  const timeline = document.timeline;
  if (target.kind === 'artwork') return artworkEvidence(document, original, target);
  if (target.kind === 'moment') return momentEvidence(document, target);
  const segments =
    target.kind === 'project'
      ? timeline.segments
      : timeline.segments.filter((segment) => segment.id === target.segmentId);
  if (target.kind === 'segment' && segments.length !== 1) return;
  const selectedSegment = segments[0];
  const events =
    target.kind === 'project'
      ? timeline.events
      : timeline.events.filter((event) => selectedSegment && eventInSegment(event, selectedSegment));
  return {
    value: {
      canvas: canvas(document),
      durationTicks: target.kind === 'project' ? timeline.durationTicks : undefined,
      segments: segments.map((segment) => segmentEvidence(document, segment)),
      events: events.map((event) => eventEvidence(document, event)),
    },
    usages: [
      ...segments.flatMap((segment) => segment.visuals.map((visual) => visualUsage(document, visual))),
      ...events.map((event) => eventUsage(document, event)),
    ],
  };
}

function artworkEvidence(
  document: Document,
  original: Document,
  target: Extract<VideoProjectReviewTarget, { kind: 'artwork' }>,
): Evidence | undefined {
  const originalUses = original.timeline.segments
    .flatMap((segment) => segment.visuals)
    .filter(
      (visual) =>
        visual.assetVersionRef === target.assetVersionRef && (!target.visualUseId || visual.id === target.visualUseId),
    );
  // A library version is immutable. Appending a version alone does not change its target.
  if (!originalUses.length) return;
  const visuals = document.timeline.segments.flatMap((segment) => segment.visuals);
  const usages: Usage[] = [];
  for (const originalUse of originalUses) {
    const replacement = visuals.find((visual) => visual.id === originalUse.id);
    if (!replacement?.assetVersionRef) return;
    const usage = visualUsage(document, replacement);
    if (!isSpatialVisualUsage(usage)) return;
    usages.push(usage);
  }
  return { value: usages.map((use) => use.content), usages };
}

function momentEvidence(
  document: Document,
  target: Extract<VideoProjectReviewTarget, { kind: 'moment' }>,
): Evidence | undefined {
  // Location hints constrain identity/time; a region independently limits proof to visible inputs.
  assertProjectReviewTarget(document, target);
  if (target.endTick !== undefined) return momentRangeEvidence(document, target);
  const timeline = document.timeline;
  const segments = timeline.segments.filter((segment) =>
    containsTick(target.tick, segment.startTick, segment.durationTicks),
  );
  const visuals = segments.flatMap((segment) =>
    segment.visuals
      .filter((visual) =>
        containsTick(target.tick - segment.startTick, visual.startTick, visual.endTick - visual.startTick),
      )
      .map((visual) => ({ segment, visual })),
  );
  if (target.region) {
    const usages = visuals
      .map(({ visual }) => visualUsage(document, visual))
      .filter(isSpatialVisualUsage)
      .map((use) => ({ ...use, position: 'frame-visual', startTick: target.tick, endTick: target.tick + 1 }));
    // Captions have no generic placement; spans do not prove changed pixels at this fixed tick.
    return { value: { canvas: canvas(document), visuals: usages.map((use) => use.content) }, usages };
  }
  const events = timeline.events.filter((event) =>
    containsTick(target.tick, event.startTick, event.durationTicks ?? 1),
  );
  return {
    value: {
      canvas: canvas(document),
      visuals: visuals.map(({ segment, visual }) => ({
        segmentStart: segment.startTick,
        segmentDuration: segment.durationTicks,
        visual: visualEvidence(document, visual),
      })),
      events: events.map((event) => eventEvidence(document, event)),
    },
    usages: [
      ...visuals.map(({ visual }) => visualUsage(document, visual)),
      ...events.map((event) => eventUsage(document, event)),
    ],
  };
}

function canvas(document: Document) {
  const { timebase, width, height } = document.timeline;
  return { timebase, width, height };
}

function segmentEvidence(document: Document, segment: Segment) {
  return {
    startTick: segment.startTick,
    durationTicks: segment.durationTicks,
    visuals: segment.visuals.map((visual) => visualEvidence(document, visual)),
  };
}

function visualEvidence(document: Document, visual: Visual) {
  return { startTick: visual.startTick, endTick: visual.endTick, content: visualUsage(document, visual).content };
}

function visualUsage(document: Document, visual: Visual) {
  const segment = document.timeline.segments.find((candidate) => candidate.visuals.includes(visual));
  if (!segment) return invalid();
  return {
    key: `visual:${visual.id}`,
    position: 'visual',
    startTick: segment.startTick + visual.startTick,
    endTick: segment.startTick + visual.endTick,
    assetVersionRef: visual.assetVersionRef,
    content: visual.assetVersionRef ? assetMaterial(document, visual.assetVersionRef) : { generated: visual.generated },
  };
}

function isSpatialVisualUsage(use: ReturnType<typeof visualUsage>): boolean {
  const material = use.content;
  return (
    !('mediaType' in material) || material.mediaType.startsWith('image/') || material.mediaType.startsWith('video/')
  );
}

function eventEvidence(document: Document, event: Event) {
  return {
    kind: event.kind,
    startTick: event.startTick,
    durationTicks: event.durationTicks,
    text: event.text,
    speaker: event.speaker,
    content: eventUsage(document, event).content,
  };
}

function eventUsage(document: Document, event: Event): Usage {
  return {
    key: `event:${event.id}`,
    position: `event:${event.kind}`,
    startTick: event.startTick,
    endTick: event.startTick + (event.durationTicks ?? 1),
    assetVersionRef: event.assetVersionRef,
    content: event.assetVersionRef ? assetMaterial(document, event.assetVersionRef) : undefined,
  };
}

function eventInSegment(event: Event, segment: Segment): boolean {
  return (
    event.startTick < segment.startTick + segment.durationTicks &&
    event.startTick + (event.durationTicks ?? 1) > segment.startTick
  );
}

function containsTick(tick: number, start: number, duration: number): boolean {
  return tick >= start && tick < start + duration;
}

function invalid(): never {
  throw new WorkspaceContentReviewError('invalid_action');
}
