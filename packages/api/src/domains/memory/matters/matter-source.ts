import { createHash } from 'node:crypto';
import type { MatterSourceCoordinate, MatterSourceInput, MessageFrom, QuoteContextAttachment } from '@cat-cafe/shared';
import {
  canReadMemorySourceThread as canReadMatterThread,
  type MemorySourceActor,
  type MemorySourceReaders,
  readMemorySourceMessage as readMatterMessage,
} from '../../cats/services/session/memory-source-access.js';
import { messageFrom } from '../../cats/services/stores/message-from.js';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

export { canReadMatterThread, readMatterMessage };
export type MatterSourceReaders = MemorySourceReaders;

export interface MatterActor extends MemorySourceActor {
  /** Bound by authenticated callback state, never accepted in the model's payload. */
  invocation?: { threadId: string; triggerMessageId?: string };
}
export class MatterMemoryError extends Error {
  constructor(
    readonly code: 'not_available' | 'invalid_source' | 'stale_revision' | 'request_conflict' | 'invalid_cursor',
    readonly detail?: { reason: string; hint: string },
  ) {
    super(code);
  }
}

export function matterDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

interface RawSegment {
  text: string;
  contentBlockIndex?: number;
  attachment?: QuoteContextAttachment;
}
function rawSegment(
  message: StoredMessage,
  source: Omit<MatterSourceInput, 'quote'>,
  diagnose = false,
): RawSegment | null {
  const invalid = (reason: string, hint: string): null => {
    if (diagnose) throw new MatterMemoryError('invalid_source', { reason, hint });
    return null;
  };
  const blocks = message.contentBlocks;
  if (source.segment === 'body') {
    if (source.attachmentId)
      return invalid('attachment', 'body has no attachmentId; omit it or select quote_comment/quote_text.');
    if (!blocks?.length) {
      if (source.contentBlockIndex !== undefined)
        return invalid('content_block', 'This message has no contentBlocks. Omit contentBlockIndex for its body.');
      return { text: message.content };
    }
    const textBlocks = blocks.flatMap((block, index) =>
      block.type === 'text' ? [{ text: block.text, contentBlockIndex: index }] : [],
    );
    const selected =
      source.contentBlockIndex === undefined
        ? textBlocks.length === 1
          ? textBlocks[0]!
          : null
        : (textBlocks.find((block) => block.contentBlockIndex === source.contentBlockIndex) ?? null);
    return (
      selected ??
      invalid(
        'content_block',
        'Read the original contentBlocks and supply the zero-based index of the text block, not its ordinal among text blocks.',
      )
    );
  }
  if (source.contentBlockIndex === undefined)
    return invalid(
      'content_block',
      'Read the original contentBlocks; quote segments require the zero-based index of their context_attachment block.',
    );
  if (!source.attachmentId)
    return invalid('attachment', 'Copy the quote attachment id from that context_attachment block.');
  const block = blocks?.[source.contentBlockIndex];
  if (block?.type !== 'context_attachment' || block.attachment.kind !== 'quote')
    return invalid(
      'content_block',
      'The selected contentBlockIndex is not a quote attachment. Read contentBlocks and choose its actual zero-based index.',
    );
  if (block.attachment.id !== source.attachmentId)
    return invalid('attachment', 'attachmentId does not match the quote at contentBlockIndex; copy its actual id.');
  return {
    text: source.segment === 'quote_comment' ? (block.attachment.comment ?? '') : block.attachment.text,
    contentBlockIndex: source.contentBlockIndex,
    attachment: block.attachment,
  };
}

function coordinateFor(
  message: StoredMessage,
  input: Omit<MatterSourceInput, 'quote'>,
  segment: RawSegment,
): MatterSourceCoordinate {
  const coordinate = {
    threadId: message.threadId,
    messageId: message.id,
    segment: input.segment,
    ...(segment.contentBlockIndex !== undefined ? { contentBlockIndex: segment.contentBlockIndex } : {}),
    ...(segment.attachment ? { attachmentId: segment.attachment.id } : {}),
    start: input.start,
    end: input.end,
  };
  const author = messageFrom(message);
  return {
    ...coordinate,
    author,
    timestamp: message.timestamp,
    sourceRevision: matterDigest({
      coordinate,
      author,
      timestamp: message.timestamp,
      text: segment.text,
      ...(segment.attachment ? { attachment: segment.attachment } : {}),
    }),
  };
}

/** Reuse the matter revision algorithm on an already authorized original, without another source read. */
export function matchesMatterSourceSelection(
  message: StoredMessage,
  selection: import('@cat-cafe/shared').MemoryMessageSelection,
): boolean {
  const { expectedRevision, ...input } = selection;
  const source = { threadId: message.threadId, messageId: message.id, ...input };
  const segment = rawSegment(message, source);
  return Boolean(segment && coordinateFor(message, source, segment).sourceRevision === expectedRevision);
}

export async function captureMatterSource(
  readers: MatterSourceReaders,
  actor: MatterActor,
  input: MatterSourceInput,
): Promise<MatterSourceCoordinate> {
  const message = await readMatterMessage(readers, actor, input);
  if (!message) throw new MatterMemoryError('not_available');
  const segment = rawSegment(message, input, true)!;
  if (input.end > segment.text.length || input.start >= input.end || input.start < 0)
    throw new MatterMemoryError('invalid_source', {
      reason: 'range',
      hint: `Use raw UTF-16 offsets inside this segment (length ${segment.text.length}), with 0 <= start < end <= length; end is exclusive.`,
    });
  if (segment.text.slice(input.start, input.end) !== input.quote)
    throw new MatterMemoryError('invalid_source', {
      reason: 'quote_mismatch',
      hint: 'quote does not match the selected raw text, including whitespace. Reread the original and correct the range/text, or write summary with a thread/message pointer instead.',
    });
  return coordinateFor(message, input, segment);
}

/** Owner's copy/paste selection resolves to the same lossless coordinate used by callback writers. */
export async function findMatterSourceSelection(
  readers: MatterSourceReaders,
  actor: MatterActor,
  input: { threadId: string; messageId: string; quote: string },
): Promise<MatterSourceInput> {
  const message = await readMatterMessage(readers, actor, input);
  if (!message) throw new MatterMemoryError('not_available');
  const candidates: Array<{
    segment: MatterSourceInput['segment'];
    contentBlockIndex?: number;
    attachmentId?: string;
    text: string;
  }> = [];
  if (!message.contentBlocks?.length) candidates.push({ segment: 'body', text: message.content });
  for (const [contentBlockIndex, block] of (message.contentBlocks ?? []).entries()) {
    if (block.type === 'text') candidates.push({ segment: 'body', contentBlockIndex, text: block.text });
    if (block.type === 'context_attachment' && block.attachment.kind === 'quote') {
      candidates.push(
        {
          segment: 'quote_comment',
          contentBlockIndex,
          attachmentId: block.attachment.id,
          text: block.attachment.comment ?? '',
        },
        { segment: 'quote_text', contentBlockIndex, attachmentId: block.attachment.id, text: block.attachment.text },
      );
    }
  }
  const matches: MatterSourceInput[] = [];
  for (const { text, ...coordinate } of candidates) {
    const start = text.indexOf(input.quote);
    if (start < 0) continue;
    if (start !== text.lastIndexOf(input.quote)) throw new MatterMemoryError('invalid_source');
    matches.push({ ...input, ...coordinate, start, end: start + input.quote.length });
  }
  if (matches.length !== 1) throw new MatterMemoryError('invalid_source');
  return matches[0]!;
}

export async function projectMatterSource(
  readers: MatterSourceReaders,
  actor: MatterActor,
  source: MatterSourceCoordinate,
): Promise<{
  sourceStatus: 'current' | 'changed';
  quote?: string;
  verifiedQuotedAuthor?: MessageFrom;
} | null> {
  const message = await readMatterMessage(readers, actor, source);
  if (!message) return null;
  const segment = rawSegment(message, source);
  if (!segment || coordinateFor(message, source, segment).sourceRevision !== source.sourceRevision)
    return { sourceStatus: 'changed' };
  const result: { sourceStatus: 'current'; quote: string; verifiedQuotedAuthor?: MessageFrom } = {
    sourceStatus: 'current',
    quote: segment.text.slice(source.start, source.end),
  };
  const attachment = segment.attachment;
  if (
    source.segment === 'quote_text' &&
    attachment?.source.kind === 'message' &&
    !attachment.source.artifactFile &&
    attachment.selectionStart !== undefined &&
    attachment.selectionEnd !== undefined
  ) {
    const quoted = await readMatterMessage(readers, actor, attachment.source);
    if (quoted) {
      const body = rawSegment(quoted, {
        ...source,
        segment: 'body',
        contentBlockIndex: undefined,
        attachmentId: undefined,
      });
      if (body && body.text.slice(attachment.selectionStart, attachment.selectionEnd) === attachment.text) {
        result.verifiedQuotedAuthor = messageFrom(quoted);
      }
    }
  }
  return result;
}
