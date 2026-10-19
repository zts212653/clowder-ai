import {
  type ArtifactReviewAnchor,
  CONTEXT_ATTACHMENT_MAX_COUNT,
  type ContextAttachment,
  ContextAttachmentsSchema,
  contentModificationOutcome,
  type MediaContextAttachment,
  MediaContextAttachmentSchema,
  reviewedMediaTypeSchema,
} from '@cat-cafe/shared';
import { COMPOSER_RECALL_PENDING_COPY, COMPOSER_TOO_LARGE_COPY } from '../composer-refusal-copy';
import { projectScreeningComposerConflict } from '../project-screening-composer-group';

/**
 * Each work's circled places stay in its own media attachment of the one original composer until the one send.
 *
 * The attachment is the canonical message form (docs/architecture/f309-media-message-contract.md): one source, up to
 * twelve stable-id selections, the person's own words stay in the message body. These functions only decide what that
 * attachment becomes when a place is added or taken away; they never read or write the composer themselves.
 */

export type MediaSelectionItem = MediaContextAttachment['selections'][number];

export interface MediaChatTarget {
  readonly title: string;
  readonly mediaType: MediaContextAttachment['mediaType'];
  readonly source: MediaContextAttachment['source'];
  readonly gallery?: MediaContextAttachment['gallery'];
  /** Only a media round that already has a Task carries one; it must name the same round as the source. */
  readonly taskContext?: MediaContextAttachment['taskContext'];
}

export const MEDIA_SELECTION_LIMIT = 12;
const INSTRUCTION_LIMIT = 4000;

export type MediaSelectionRefusal =
  /** Places outside this original message group, or another version of this work, are already waiting. */
  | 'other_source'
  | 'full'
  /** The composer already holds the most things a message can carry; a draft past that is discarded, so refuse. */
  | 'composer_full'
  /** The selection kind must agree with its admitted image or video source. */
  | 'not_image'
  /**
   * The whole work is already waiting (an empty set of places means exactly that). Adding a place would silently
   * narrow it to that one place, and one message may not mix the whole work with chosen places.
   */
  | 'whole_work_pending'
  | 'selected_places_pending'
  /** One place's words, or all places' words together, exceed what a request carries. */
  | 'too_long'
  /**
   * The place itself is fine, but the composer with it applied would no longer be a collection one message can carry
   * (the canonical collection rule, including the combined size of what the model is handed). The draft store throws
   * a collection past that away whole, so it is refused here, before anything is queued or cleared.
   */
  | 'too_large'
  /** The shared message schema would reject the result, so it is refused here instead of failing at send. */
  | 'invalid'
  /** The input has not yet taken the answer to a recall waiting for it; a place added now would be taken as saved. */
  | 'recall_pending';

export type AddMediaSelection =
  | { readonly kind: 'added'; readonly attachment: MediaContextAttachment; readonly selectionId: string }
  | { readonly kind: 'refused'; readonly reason: MediaSelectionRefusal };

/** Words for a refusal, in the person's terms. One place so every surface says the same thing. */
export const MEDIA_SELECTION_REFUSAL_COPY = {
  other_source: '输入框里已有另一幅作品的选区或另一版成片的位置。请先发送或移除它们，再添加这处。',
  full: `一条消息最多 ${MEDIA_SELECTION_LIMIT} 处选区。`,
  composer_full: '输入框里的引用已满，请先发送或移除几个。',
  not_image: '这份媒体当前不能携带这种选区。图片请圈选或点选；视频请选择时间段或圈这一帧。',
  whole_work_pending: '输入框里已经引用了整件作品。请先移除它，再选区域。',
  selected_places_pending: '输入框里已有这幅作品的选区。请先发送或移除它们，再引用整图。',
  too_long: '这处说明太长了，请精简后再放进对话。',
  too_large: COMPOSER_TOO_LARGE_COPY,
  invalid: '这处选区暂时无法放进对话。',
  recall_pending: COMPOSER_RECALL_PENDING_COPY,
  no_thread: '请先打开一个对话，再把选区放进去。',
} as const satisfies Record<MediaSelectionRefusal | 'no_thread', string>;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  return value;
}

/** Content identity that does not depend on key order. */
function stableKey(value: unknown): string {
  return JSON.stringify(sortKeys(value ?? null));
}

function hash32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The id a NEW media attachment starts with, derived from its source. An attachment that already exists keeps the id it
 * has: the frozen contract only asks for a legal stable id, so one restored from a draft (say `cover`) is never
 * re-derived, or growing it would no longer replace it.
 */
export function mediaAttachmentId(source: MediaContextAttachment['source']): string {
  return `media-${hash32(stableKey(source))}`;
}

/** A new attachment's id, kept clear of whatever the composer already holds: a duplicate id is silently dropped by the merge. */
function freshAttachmentId(current: readonly ContextAttachment[], source: MediaContextAttachment['source']): string {
  const base = mediaAttachmentId(source);
  const taken = new Set(current.map((attachment) => attachment.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function sameMediaSource(
  a: Pick<MediaContextAttachment, 'source' | 'taskContext'>,
  b: Pick<MediaContextAttachment, 'source' | 'taskContext'>,
): boolean {
  return stableKey(a.source) === stableKey(b.source) && stableKey(a.taskContext) === stableKey(b.taskContext);
}

/** Presentation admits exactly the MIME values carried by the original shared message contract. */
export function mediaChatMime(mime: string): MediaContextAttachment['mediaType'] | null {
  const parsed = reviewedMediaTypeSchema.safeParse(mime);
  return parsed.success ? parsed.data : null;
}

/** The exact original source and admitted MIME; an unsupported type or empty title is never guessed. */
export function mediaChatTarget(input: {
  readonly title: string;
  readonly mime: string;
  readonly source: MediaContextAttachment['source'];
  readonly gallery?: MediaContextAttachment['gallery'];
  readonly taskContext?: MediaContextAttachment['taskContext'];
}): MediaChatTarget | null {
  const mediaType = mediaChatMime(input.mime);
  if (!mediaType) return null;
  const title = input.title.trim().slice(0, 300);
  if (!title) return null;
  return {
    title,
    mediaType,
    source: input.source,
    ...(input.gallery ? { gallery: input.gallery } : {}),
    ...(input.taskContext ? { taskContext: input.taskContext } : {}),
  };
}

/** The label a person reads for a place: what they did, never its coordinates. */
export function mediaSelectionLabel(item: MediaSelectionItem): '圈选' | '点选' | '时间段' | '圈这一帧' {
  if (item.selection.kind === 'video-range')
    return item.selection.frameRegion || item.selection.framePoint ? '圈这一帧' : '时间段';
  return item.selection.kind === 'image-point' ? '点选' : '圈选';
}

export function pendingMediaAttachment(
  list: readonly ContextAttachment[],
  target?: MediaChatTarget,
): MediaContextAttachment | undefined {
  return list.find(
    (attachment): attachment is MediaContextAttachment =>
      attachment.kind === 'media' &&
      (!target ||
        (sameMediaSource(attachment, target) &&
          (!target.gallery ||
            !attachment.gallery ||
            (sameGalleryGroup(attachment.gallery, target.gallery) &&
              attachment.gallery.index === target.gallery.index)))),
  );
}

export function sameGalleryGroup(
  a: NonNullable<MediaChatTarget['gallery']>,
  b: NonNullable<MediaChatTarget['gallery']>,
): boolean {
  return (
    a.threadId === b.threadId &&
    a.messageId === b.messageId &&
    a.messageRevision === b.messageRevision &&
    a.count === b.count
  );
}

/** More than one source is admitted only within the same explicit original-message group. */
function otherMediaSource(current: readonly ContextAttachment[], target: MediaChatTarget): boolean {
  return current.some((item) => {
    if (item.kind !== 'media') return false;
    const a = item.gallery,
      b = target.gallery;
    if (sameMediaSource(item, target) && (!a || !b)) return false;
    return !a || !b || !sameGalleryGroup(a, b) || (a.index === b.index && !sameMediaSource(item, target));
  });
}

function nextSelectionId(selections: readonly MediaSelectionItem[]): string {
  // Ids are opaque to the server; a number keeps them readable. Survivors are never renumbered and an id a
  // surviving place still holds is never handed out again: one more than the largest numeric id cannot equal any
  // id there already (a non-numeric id is never a digit string). BigInt, because a restored id may be larger than a
  // double can count past (2^53 + 1 is 2^53 again, and a double rounds an odd integer above 2^53).
  const highest = selections.reduce((max, item) => {
    if (!/^\d+$/.test(item.id)) return max;
    const value = BigInt(item.id);
    return value > max ? value : max;
  }, BigInt(0));
  return String(highest + BigInt(1));
}

/** The words of all places together, by the rule a request is admitted under (the person's own words come on top). */
function placesWordsTooLong(selections: readonly MediaSelectionItem[]): boolean {
  if (!selections.some((item) => item.instruction)) return false;
  try {
    contentModificationOutcome({ body: '', selections: [...selections] });
    return false;
  } catch (error) {
    if (error instanceof Error && error.message === 'modification_intent_length') return true;
    throw error;
  }
}

/** Why a place cannot be added at all, judged before anything is built; null when it can. */
function refusalBefore(
  current: readonly ContextAttachment[],
  pending: MediaContextAttachment | undefined,
  target: MediaChatTarget,
  anchor: ArtifactReviewAnchor,
  words: string,
): MediaSelectionRefusal | null {
  if ((target.mediaType === 'video/mp4') !== (anchor.kind === 'video-range')) return 'not_image';
  if (words.length > INSTRUCTION_LIMIT) return 'too_long';
  if (otherMediaSource(current, target)) return 'other_source';
  if (
    current.reduce((count, item) => count + (item.kind === 'media' ? item.selections.length : 0), 0) >=
    MEDIA_SELECTION_LIMIT
  )
    return 'full';
  if (!pending) return current.length >= CONTEXT_ATTACHMENT_MAX_COUNT ? 'composer_full' : null;
  if (!sameMediaSource(pending, target)) return 'other_source';
  if (pending.selections.length === 0) return 'whole_work_pending';
  return pending.selections.length >= MEDIA_SELECTION_LIMIT ? 'full' : null;
}

/**
 * Whether the composer, once this attachment lands in it (replacing the one it grows, or added as a new one), is still
 * a collection one message can carry by the canonical rule: the attachment alone being valid says nothing about the
 * whole message.
 */
function collectionRefusal(
  current: readonly ContextAttachment[],
  pending: MediaContextAttachment | undefined,
  attachment: MediaContextAttachment,
): MediaSelectionRefusal | null {
  const effective = pending
    ? current.map((item) => (item.id === pending.id ? attachment : item))
    : [...current, attachment];
  if (projectScreeningComposerConflict(effective)) return 'other_source';
  return ContextAttachmentsSchema.safeParse(effective).success ? null : 'too_large';
}

export type AddMediaWork =
  | { readonly kind: 'added'; readonly attachment: MediaContextAttachment }
  | { readonly kind: 'refused'; readonly reason: MediaSelectionRefusal };

/** An empty selection list is the canonical whole-work reference, never a synthetic full-canvas selection. */
export function addMediaWork(current: readonly ContextAttachment[], target: MediaChatTarget): AddMediaWork {
  const pending = pendingMediaAttachment(current, target);
  if (otherMediaSource(current, target)) return { kind: 'refused', reason: 'other_source' };
  if (pending?.selections.length) return { kind: 'refused', reason: 'selected_places_pending' };
  if (pending) return { kind: 'added', attachment: pending };
  if (current.length >= CONTEXT_ATTACHMENT_MAX_COUNT) return { kind: 'refused', reason: 'composer_full' };
  const parsed = MediaContextAttachmentSchema.safeParse({
    v: 1,
    id: freshAttachmentId(current, target.source),
    kind: 'media',
    title: target.title,
    mediaType: target.mediaType,
    source: target.source,
    ...(target.gallery ? { gallery: target.gallery } : {}),
    ...(target.taskContext ? { taskContext: target.taskContext } : {}),
    selections: [],
  });
  if (!parsed.success) return { kind: 'refused', reason: 'invalid' };
  const refusal = collectionRefusal(current, undefined, parsed.data);
  if (refusal) return { kind: 'refused', reason: refusal };
  return { kind: 'added', attachment: parsed.data };
}

export function addMediaSelection(
  current: readonly ContextAttachment[],
  target: MediaChatTarget,
  anchor: ArtifactReviewAnchor,
  instruction?: string,
): AddMediaSelection {
  const words = instruction?.trim() ?? '';
  const pending = pendingMediaAttachment(current, target);
  const refusal = refusalBefore(current, pending, target, anchor, words);
  if (refusal) return { kind: 'refused', reason: refusal };

  const existing = pending?.selections ?? [];
  const selectionId = nextSelectionId(current.flatMap((item) => (item.kind === 'media' ? item.selections : [])));
  const selections = [...existing, { id: selectionId, selection: anchor, ...(words ? { instruction: words } : {}) }];
  if (placesWordsTooLong(selections)) return { kind: 'refused', reason: 'too_long' };
  const parsed = MediaContextAttachmentSchema.safeParse({
    v: 1,
    // Growing keeps the id the attachment already has; only a new one gets a derived id.
    id: pending?.id ?? freshAttachmentId(current, target.source),
    kind: 'media',
    title: target.title,
    mediaType: target.mediaType,
    source: target.source,
    ...((target.gallery ?? pending?.gallery) ? { gallery: target.gallery ?? pending?.gallery } : {}),
    ...(target.taskContext ? { taskContext: target.taskContext } : {}),
    selections,
  });
  if (!parsed.success) return { kind: 'refused', reason: 'invalid' };
  const collectionError = collectionRefusal(current, pending, parsed.data);
  if (collectionError) return { kind: 'refused', reason: collectionError };
  return { kind: 'added', attachment: parsed.data, selectionId };
}

/**
 * Takes one place away. When the last one goes the whole attachment goes with it: an empty selection set means
 * "the whole work" in the message contract, and removing a circle must never turn into asking for that.
 */
export function removeMediaSelection(
  attachment: MediaContextAttachment,
  selectionId: string,
): MediaContextAttachment | null {
  if (!attachment.selections.some((item) => item.id === selectionId)) return attachment;
  const selections = attachment.selections.filter((item) => item.id !== selectionId);
  return selections.length ? { ...attachment, selections } : null;
}
