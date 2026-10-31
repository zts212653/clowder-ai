import {
  type ArtifactReviewAnchor,
  type ContextAttachment,
  ContextAttachmentsSchema,
  type MediaContextAttachment,
  MediaContextAttachmentSchema,
} from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  addMediaSelection,
  type MediaChatTarget,
  mediaAttachmentId,
  mediaChatTarget,
  mediaSelectionLabel,
  pendingMediaAttachment,
  removeMediaSelection,
  sameMediaSource,
} from '../media-chat-selection';

const SOURCE = {
  kind: 'workspace',
  locator: { worktreeId: 'wt-1', path: 'art/cover.png' },
  expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
  reviewId: 'review-1',
  expectedReviewRevision: 3,
} as const;

const target = (over: Partial<MediaChatTarget> = {}): MediaChatTarget => ({
  title: 'cover.png',
  mediaType: 'image/png',
  source: SOURCE,
  ...over,
});

const REGION: ArtifactReviewAnchor = { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 };
const POINT: ArtifactReviewAnchor = { kind: 'image-point', x: 120, y: 70 };
const added = (result: ReturnType<typeof addMediaSelection>) => {
  if (result.kind !== 'added')
    throw new Error(`expected added, got ${result.kind}:${'reason' in result ? result.reason : ''}`);
  return result.attachment;
};

describe('addMediaSelection — one pending media attachment per message', () => {
  it('starts one attachment for the first circled place and keeps the original words out of it', () => {
    const result = addMediaSelection([], target(), REGION, '  移除这里的字  ');
    expect(result.kind).toBe('added');
    const attachment = added(result);
    expect(attachment).toMatchObject({
      v: 1,
      kind: 'media',
      title: 'cover.png',
      mediaType: 'image/png',
      source: SOURCE,
      selections: [{ id: '1', selection: REGION, instruction: '移除这里的字' }],
    });
    expect(attachment.id).toBe(mediaAttachmentId(SOURCE));
    expect(MediaContextAttachmentSchema.safeParse(attachment).success).toBe(true);
  });

  it('leaves the local instruction out when it is empty or only whitespace', () => {
    const attachment = added(addMediaSelection([], target(), POINT, '   '));
    expect(attachment.selections[0]).toEqual({ id: '1', selection: POINT });
    expect('instruction' in attachment.selections[0]).toBe(false);
  });

  it('adds a second place to the same attachment, in order, without renumbering', () => {
    const first = added(addMediaSelection([], target(), REGION));
    const second = added(addMediaSelection([first], target(), POINT, '这里加星星'));
    expect(second.id).toBe(first.id);
    expect(second.selections.map((item) => item.id)).toEqual(['1', '2']);
    expect(second.selections[1]).toEqual({ id: '2', selection: POINT, instruction: '这里加星星' });
    expect(second.selections[0]).toEqual(first.selections[0]);
  });

  it('never reuses an id a surviving selection still holds, and never renumbers survivors', () => {
    const first = added(addMediaSelection([], target(), REGION));
    const two = added(addMediaSelection([first], target(), POINT));
    const withoutFirst = removeMediaSelection(two, '1');
    expect(withoutFirst?.selections.map((item) => item.id)).toEqual(['2']);
    const third = added(addMediaSelection([withoutFirst as ContextAttachment], target(), REGION));
    expect(third.selections.map((item) => item.id)).toEqual(['2', '3']);
  });

  it('only touches the media attachment among the other things already in the composer', () => {
    const quote: ContextAttachment = {
      v: 1,
      id: 'quote-1',
      kind: 'quote',
      text: 'hello',
      source: { kind: 'workspace_file', path: 'a.md' },
    };
    expect(pendingMediaAttachment([quote])).toBeUndefined();
    const result = addMediaSelection([quote], target(), REGION);
    expect(result.kind).toBe('added');
    const media = added(result);
    expect(pendingMediaAttachment([quote, media])).toEqual(media);
  });

  it('says so when another work already has circled places waiting, and changes nothing', () => {
    const first = added(addMediaSelection([], target(), REGION));
    const other = target({ source: { ...SOURCE, locator: { worktreeId: 'wt-1', path: 'art/other.png' } } });
    expect(addMediaSelection([first], other, POINT)).toEqual({ kind: 'refused', reason: 'other_source' });
  });

  it('treats a different Task context or version of the same work as another source too', () => {
    const first = added(addMediaSelection([], target(), REGION));
    const newer = target({ source: { ...SOURCE, expectedReviewRevision: 4 } });
    expect(addMediaSelection([first], newer, POINT)).toEqual({ kind: 'refused', reason: 'other_source' });
  });

  it('stops at twelve places with a typed refusal instead of truncating', () => {
    let current: ContextAttachment[] = [];
    for (let i = 0; i < 12; i++) current = [added(addMediaSelection(current, target(), { ...REGION, x: i }))];
    expect((current[0] as { selections: unknown[] }).selections).toHaveLength(12);
    expect(addMediaSelection(current, target(), POINT)).toEqual({ kind: 'refused', reason: 'full' });
  });

  it('does not start a new media attachment when the composer already holds twelve things', () => {
    // The persisted draft is thrown away as invalid past twelve attachments, so a thirteenth must be refused out loud.
    const twelve: ContextAttachment[] = Array.from({ length: 12 }, (_, i) => ({
      v: 1,
      id: `quote-${i}`,
      kind: 'quote',
      text: 'x',
      source: { kind: 'workspace_file', path: 'a.md' },
    }));
    expect(addMediaSelection(twelve, target(), REGION)).toEqual({ kind: 'refused', reason: 'composer_full' });
    // A media attachment already in the list grows in place and does not need a new slot.
    const eleven = twelve.slice(0, 11);
    const first = added(addMediaSelection(eleven, target(), REGION));
    expect(addMediaSelection([...eleven, first], target(), POINT).kind).toBe('added');
  });

  it('refuses what the image path does not carry: video targets, video ranges and oversized instructions', () => {
    expect(addMediaSelection([], target({ mediaType: 'video/mp4' }), REGION)).toEqual({
      kind: 'refused',
      reason: 'not_image',
    });
    const range: ArtifactReviewAnchor = {
      kind: 'video-range',
      streamId: 's',
      startTick: 0,
      endTick: 10,
    } as ArtifactReviewAnchor;
    expect(addMediaSelection([], target(), range)).toEqual({ kind: 'refused', reason: 'not_image' });
    expect(addMediaSelection([], target(), REGION, 'x'.repeat(4001))).toEqual({ kind: 'refused', reason: 'too_long' });
    // The request counts a place as "[id] words", so with id "1" the longest words it can carry are 4000 - 4.
    expect(addMediaSelection([], target(), REGION, 'x'.repeat(3996)).kind).toBe('added');
    expect(addMediaSelection([], target(), REGION, 'x'.repeat(3997))).toEqual({ kind: 'refused', reason: 'too_long' });
  });

  it('carries a Task context only when the round has one, and it must name the same round', () => {
    const roundSource = { kind: 'artifact-review', reviewId: 'r-9', round: 2, expectedReviewRevision: 5 } as const;
    const taskContext = {
      kind: 'media',
      taskId: 'task-1',
      expectedTaskRevision: 7,
      reviewId: 'r-9',
      expectedReviewRevision: 5,
      round: 2,
    } as const;
    const attachment = added(addMediaSelection([], target({ source: roundSource, taskContext }), REGION));
    expect(attachment.taskContext).toEqual(taskContext);
    expect(MediaContextAttachmentSchema.safeParse(attachment).success).toBe(true);
    // A context that names another round is not accepted by the shared schema, so it is refused here, not sent.
    expect(
      addMediaSelection([], target({ source: roundSource, taskContext: { ...taskContext, round: 3 } }), REGION),
    ).toEqual({ kind: 'refused', reason: 'invalid' });
  });
});

// A place must be judged against the composer it will join, by the same rules the send applies to the whole
// collection and to the combined words, not only against its own attachment.
describe('addMediaSelection — the effective collection', () => {
  const bigQuote = (): ContextAttachment => ({
    v: 1,
    id: 'quote-big',
    kind: 'quote',
    // '<' is escaped in the model projection, so this stays a legal stored reference yet nearly fills the budget.
    text: '<'.repeat(7900),
    source: { kind: 'workspace_file', path: 'a.md' },
  });

  it('refuses a place that would push the whole composer past what one message can carry', () => {
    const quote = bigQuote();
    expect(ContextAttachmentsSchema.safeParse([quote]).success, 'the stored reference alone is legitimate').toBe(true);
    expect(addMediaSelection([quote], target(), REGION, 'x'.repeat(1000))).toEqual({
      kind: 'refused',
      reason: 'too_large',
    });
  });

  it('applies the same rule when an attachment already in the composer grows', () => {
    const quote = bigQuote();
    const first = added(addMediaSelection([quote], target(), REGION, 'a'.repeat(10)));
    const list = [quote, first];
    expect(ContextAttachmentsSchema.safeParse(list).success, 'the composer is legitimate before the growth').toBe(true);
    expect(addMediaSelection(list, target(), POINT, 'b'.repeat(800))).toEqual({ kind: 'refused', reason: 'too_large' });
  });

  it('still adds when the whole collection stays inside the limit', () => {
    const result = addMediaSelection([bigQuote()], target(), REGION, 'x'.repeat(10));
    expect(result.kind).toBe('added');
    const grown = [bigQuote(), added(result)];
    expect(ContextAttachmentsSchema.safeParse(grown).success).toBe(true);
  });

  it('refuses words that together exceed what a request can carry, by the canonical aggregate rule', () => {
    const first = added(addMediaSelection([], target(), REGION, 'a'.repeat(2000)));
    // The aggregate is "[id] words" lines joined, so the ids and line breaks count too.
    expect(addMediaSelection([first], target(), POINT, 'b'.repeat(2000))).toEqual({
      kind: 'refused',
      reason: 'too_long',
    });
    expect(addMediaSelection([first], target(), POINT, 'b'.repeat(1000)).kind).toBe('added');
  });
});

describe('addMediaSelection — identity of what is restored', () => {
  const restoredCover = (): MediaContextAttachment => ({
    v: 1,
    id: 'cover',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: SOURCE,
    selections: [{ id: '1', selection: REGION }],
  });

  it('grows a legitimately restored attachment in place under the id it already has', () => {
    const result = addMediaSelection([restoredCover()], target(), POINT, '这里加星星');
    expect(result.kind).toBe('added');
    const grown = added(result);
    expect(grown.id).toBe('cover');
    expect(grown.selections.map((item) => item.id)).toEqual(['1', '2']);
  });

  it('keeps that id after a place is taken away and another is added', () => {
    const restored = added(addMediaSelection([restoredCover()], target(), POINT));
    const without = removeMediaSelection(restored, '1') as MediaContextAttachment;
    expect(without.id).toBe('cover');
    const again = added(addMediaSelection([without], target(), REGION));
    expect(again.id).toBe('cover');
    expect(again.selections.map((item) => item.id)).toEqual(['2', '3']);
  });

  it('never gives a new attachment an id some other attachment in the composer already holds', () => {
    const squatter: ContextAttachment = {
      v: 1,
      id: mediaAttachmentId(SOURCE),
      kind: 'quote',
      text: 'hello',
      source: { kind: 'workspace_file', path: 'a.md' },
    };
    const result = added(addMediaSelection([squatter], target(), REGION));
    expect(result.id).not.toBe(squatter.id);
    expect(result.id.startsWith(mediaAttachmentId(SOURCE))).toBe(true);
  });

  it('never hands out a selection id a surviving place still holds, even a very large numeric one', () => {
    // Above 2^53 a double cannot count: 2^53 + 1 is 2^53 again, and 2^53 + 1 read as a number is 2^53. Counting in
    // doubles would hand one of these two ids out a second time, in either of the ways it can go wrong.
    expect(Number('9007199254740992') + 1).toBe(Number('9007199254740992'));
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'));
    const restored: MediaContextAttachment = {
      ...restoredCover(),
      selections: [
        { id: '9007199254740992', selection: REGION },
        { id: '9007199254740993', selection: POINT },
      ],
    };
    const grown = added(addMediaSelection([restored], target(), POINT));
    const ids = grown.selections.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe('9007199254740994');
    expect(MediaContextAttachmentSchema.safeParse(grown).success).toBe(true);
  });

  it('numbers after restored ids that are not numbers at all', () => {
    const restored: MediaContextAttachment = {
      ...restoredCover(),
      selections: [{ id: 'left-logo', selection: REGION }],
    };
    expect(added(addMediaSelection([restored], target(), POINT)).selections.map((item) => item.id)).toEqual([
      'left-logo',
      '1',
    ]);
  });
});

describe('addMediaSelection — a whole-work attachment already waiting', () => {
  const wholeWork = (): MediaContextAttachment => ({
    v: 1,
    id: 'whole',
    kind: 'media',
    title: 'cover.png',
    mediaType: 'image/png',
    source: SOURCE,
    selections: [],
  });

  it('is not silently narrowed to one place: an empty set means the whole work, and a place is a different request', () => {
    expect(addMediaSelection([wholeWork()], target(), REGION)).toEqual({
      kind: 'refused',
      reason: 'whole_work_pending',
    });
  });
});

describe('removeMediaSelection', () => {
  it('drops one place and keeps the rest exactly as they were', () => {
    const one = added(addMediaSelection([], target(), REGION, 'a'));
    const two = added(addMediaSelection([one], target(), POINT, 'b'));
    const rest = removeMediaSelection(two, '1');
    expect(rest?.selections).toEqual([{ id: '2', selection: POINT, instruction: 'b' }]);
    expect(rest?.id).toBe(two.id);
  });

  it('removes the whole attachment when the last place goes, never leaving an empty set that means the whole work', () => {
    const one = added(addMediaSelection([], target(), REGION));
    expect(removeMediaSelection(one, '1')).toBeNull();
  });

  it('is a no-op for an id that is not there', () => {
    const one = added(addMediaSelection([], target(), REGION));
    expect(removeMediaSelection(one, 'nope')).toEqual(one);
  });
});

describe('mediaChatTarget', () => {
  it('builds the target a request names, with the Task context when the round has one', () => {
    const taskContext = {
      kind: 'media',
      taskId: 't',
      expectedTaskRevision: 1,
      reviewId: 'review-1',
      expectedReviewRevision: 3,
      round: 1,
    } as const;
    expect(mediaChatTarget({ title: 'cover.png', mime: 'image/png', source: SOURCE })).toEqual({
      title: 'cover.png',
      mediaType: 'image/png',
      source: SOURCE,
    });
    expect(mediaChatTarget({ title: 'cover.png', mime: 'image/png', source: SOURCE, taskContext })).toMatchObject({
      taskContext,
    });
  });

  it.each([
    ['jpg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('retains the actual %s original and MIME when handing its circled place to Chat', (extension, mime) => {
    const source = { ...SOURCE, locator: { ...SOURCE.locator, path: `art/original.${extension}` } };
    const result = mediaChatTarget({ title: `original.${extension}`, mime, source });
    expect(result).toEqual({ title: `original.${extension}`, mediaType: mime, source });
    if (!result) throw new Error('the original image must be a real Chat target');
    const attachment = added(addMediaSelection([], result, REGION));
    expect(attachment.source).toEqual(source);
    expect(attachment.selections).toEqual([{ id: '1', selection: REGION }]);
  });

  it.each([
    ['jpg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('the shared message contract carries a %s without disguising its original bytes as PNG', (extension, mime) => {
    const source = { ...SOURCE, locator: { ...SOURCE.locator, path: `art/original.${extension}` } };
    expect(
      MediaContextAttachmentSchema.safeParse({
        v: 1,
        id: 'original-media',
        kind: 'media',
        title: `original.${extension}`,
        mediaType: mime,
        source,
        selections: [{ id: '1', selection: REGION }],
      }).success,
    ).toBe(true);
  });

  it('is null for an unsupported type instead of guessing an accepted format', () => {
    expect(mediaChatTarget({ title: 'a.gif', mime: 'image/gif', source: SOURCE })).toBeNull();
    expect(mediaChatTarget({ title: 'a.svg', mime: 'image/svg+xml', source: SOURCE })).toBeNull();
  });

  it('uses a name the shared schema accepts, never an empty one', () => {
    expect(mediaChatTarget({ title: '   ', mime: 'image/png', source: SOURCE })).toBeNull();
    expect(mediaChatTarget({ title: 'x'.repeat(301), mime: 'image/png', source: SOURCE })?.title).toHaveLength(300);
  });
});

describe('identity helpers', () => {
  it('compares sources by content, not by key order', () => {
    const reordered = {
      reviewId: 'review-1',
      expectedReviewRevision: 3,
      expectedSourceRevision: SOURCE.expectedSourceRevision,
      locator: { path: 'art/cover.png', worktreeId: 'wt-1' },
      kind: 'workspace',
    } as const;
    expect(sameMediaSource({ source: SOURCE }, { source: reordered })).toBe(true);
    expect(mediaAttachmentId(SOURCE)).toBe(mediaAttachmentId(reordered));
    expect(sameMediaSource({ source: SOURCE }, { source: { ...SOURCE, expectedReviewRevision: 4 } })).toBe(false);
  });

  it('gives an id the shared schema accepts for any source', () => {
    expect(mediaAttachmentId(SOURCE)).toMatch(/^media-[0-9a-f]{8}$/);
  });

  it('labels each place by what the person did, never by coordinates', () => {
    expect(mediaSelectionLabel({ id: '1', selection: REGION })).toBe('圈选');
    expect(mediaSelectionLabel({ id: '2', selection: POINT })).toBe('点选');
  });
});
