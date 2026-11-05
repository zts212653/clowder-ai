import { type ArtifactReviewAnchor, MediaContextAttachmentSchema } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { addMediaSelection, addMediaWork, type MediaChatTarget, removeMediaSelection } from '../media-chat-selection';

const SOURCE = {
  kind: 'workspace',
  locator: { worktreeId: 'video-worktree', path: 'art/film-v2.mp4' },
  expectedSourceRevision: `sha256:${'b'.repeat(64)}`,
  reviewId: 'video-review',
  expectedReviewRevision: 3,
} as const;
const VIDEO: MediaChatTarget = { title: 'film-v2.mp4', mediaType: 'video/mp4', source: SOURCE };
// The observed 338.4s source uses 1/15360 ticks, not an assumed millisecond or frame-number clock.
const RANGE: ArtifactReviewAnchor = {
  kind: 'video-range',
  streamId: 'original-video-stream',
  startTick: 1228800,
  endTick: 1320960,
  frameRegion: { tick: 1259520, x: 320, y: 180, width: 200, height: 120 },
};
const SECOND: ArtifactReviewAnchor = {
  kind: 'video-range',
  streamId: 'original-video-stream',
  startTick: 1536000,
  endTick: 1582080,
  framePoint: { tick: 1551360, x: 640, y: 360 },
};

function added(result: ReturnType<typeof addMediaSelection>) {
  if (result.kind !== 'added') throw new Error(`expected video selection, received ${result.reason}`);
  return result.attachment;
}

describe('video places in the one original Chat attachment', () => {
  it('freezes paragraph text and metadata revision in the original version-bound selection', () => {
    const story = {
      ...RANGE,
      storyEvidence: { paragraphId: 'opening', metadataRevision: 3, quote: '原来的话\n保留换行' },
    };
    const attachment = added(addMediaSelection([], VIDEO, story));
    expect(attachment.selections[0]?.selection).toEqual(story);
    expect(MediaContextAttachmentSchema.parse(attachment).selections[0]?.selection).toEqual(story);
  });

  it('carries the original stream, ticks, frame region and version without converting their coordinates', () => {
    const attachment = added(addMediaSelection([], VIDEO, RANGE, '把这一段缩短'));
    expect(attachment.mediaType).toBe('video/mp4');
    expect(attachment.source).toEqual(SOURCE);
    expect(attachment.selections).toEqual([{ id: '1', selection: RANGE, instruction: '把这一段缩短' }]);
    expect(MediaContextAttachmentSchema.safeParse(attachment).success).toBe(true);
  });

  it('grows one source attachment without renumbering a surviving range or changing its presented frame', () => {
    const first = added(addMediaSelection([], VIDEO, RANGE));
    const second = added(addMediaSelection([first], VIDEO, SECOND));
    const surviving = removeMediaSelection(second, '1');
    if (!surviving) throw new Error('the second video range must survive removing the first');
    const grown = added(addMediaSelection([surviving], VIDEO, RANGE));
    expect(grown.id).toBe(first.id);
    expect(grown.selections).toEqual([
      { id: '2', selection: SECOND },
      { id: '3', selection: RANGE },
    ]);
    expect(surviving.selections).toEqual([{ id: '2', selection: SECOND }]);
  });

  it('keeps an empty video selection set as the existing whole-work reference', () => {
    const result = addMediaWork([], VIDEO);
    expect(result.kind).toBe('added');
    if (result.kind !== 'added') throw new Error('whole-video references already belong to the message contract');
    expect(result.attachment.source).toEqual(SOURCE);
    expect(result.attachment.selections).toEqual([]);
    expect(MediaContextAttachmentSchema.safeParse(result.attachment).success).toBe(true);
  });

  it('continues refusing a video frame on a PNG source rather than relabeling it as an image region', () => {
    const image: MediaChatTarget = {
      title: 'cover.png',
      mediaType: 'image/png',
      source: { ...SOURCE, locator: { ...SOURCE.locator, path: 'art/cover.png' } },
    };
    expect(addMediaSelection([], image, RANGE)).toEqual({ kind: 'refused', reason: 'not_image' });
  });

  it('refuses a frame on the exclusive range end without clamping its tick into the selection', () => {
    const anchor: ArtifactReviewAnchor = {
      kind: 'video-range',
      streamId: 'original-video-stream',
      startTick: 1228800,
      endTick: 1320960,
      frameRegion: { tick: 1320960, x: 320, y: 180, width: 200, height: 120 },
    };
    expect(addMediaSelection([], VIDEO, anchor)).toEqual({ kind: 'refused', reason: 'invalid' });
    expect(anchor.frameRegion?.tick).toBe(1320960);
  });

  it('refuses two incompatible frame anchors instead of dropping either from the original selection', () => {
    const anchor: ArtifactReviewAnchor = {
      kind: 'video-range',
      streamId: 'original-video-stream',
      startTick: 1228800,
      endTick: 1320960,
      frameRegion: { tick: 1259520, x: 320, y: 180, width: 200, height: 120 },
      framePoint: { tick: 1259520, x: 640, y: 360 },
    };
    expect(addMediaSelection([], VIDEO, anchor)).toEqual({ kind: 'refused', reason: 'invalid' });
    expect(anchor.frameRegion).toEqual({ tick: 1259520, x: 320, y: 180, width: 200, height: 120 });
    expect(anchor.framePoint).toEqual({ tick: 1259520, x: 640, y: 360 });
  });
});
