import { createHash } from 'node:crypto';
import {
  type MessageSearchResult,
  type MessageSourceSelection,
  resolveSharedMarkdownSelection,
  type SelectedMessageSource,
} from '@cat-cafe/shared';
import { storedMessageSource } from '../cats/services/stores/message-source.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { projectMessageSearchSpeaker } from './message-search-projection.js';
import { selectedMessageContext, selectedMessageHeadings } from './message-selected-context.js';
import { type MessageSourceTextPart, messageSourceParts } from './message-source-parts.js';

export interface AdmittedSelectedSource {
  message: StoredMessage;
  result: MessageSearchResult;
}
export type SelectedSourceReader = (ref: {
  threadId: string;
  messageId: string;
}) => Promise<AdmittedSelectedSource | null>;
export class MessageSelectionError extends Error {
  readonly statusCode = 409;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

/** Text-only search revisions do not cover a changed quote source, publisher or paired comment. */
export function selectedSourceDigest(message: StoredMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          content: message.content,
          blocks: message.contentBlocks,
          from: message.from,
          catId: message.catId,
          source: storedMessageSource(message),
          attribution: projectMessageSearchSpeaker(message),
          timestamp: message.timestamp,
        }),
      ),
    )
    .digest('hex');
}

function boundary(text: string, at: number): boolean {
  const previous = text.charCodeAt(at - 1),
    current = text.charCodeAt(at);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function locate(parts: MessageSourceTextPart[], input: SelectedMessageSource) {
  const matches: Array<{ part: MessageSourceTextPart; start: number; end: number }> = [];
  for (const part of parts) {
    if (input.part && JSON.stringify(input.part) !== JSON.stringify(part.part)) continue;
    if (input.range) {
      const { start, end } = input.range;
      if (
        end <= part.text.length &&
        part.text.slice(start, end) === input.quote &&
        boundary(part.text, start) &&
        boundary(part.text, end)
      )
        matches.push({ part, start, end });
      continue;
    }
    for (let at = part.text.indexOf(input.quote); at >= 0; at = part.text.indexOf(input.quote, at + 1)) {
      const end = at + input.quote.length;
      if (boundary(part.text, at) && boundary(part.text, end)) matches.push({ part, start: at, end });
      if (matches.length > 1) return null;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Verify the whole reproduced quote, not merely a convenient phrase in another message. */
async function quotedOrigin(part: MessageSourceTextPart, read: SelectedSourceReader) {
  const source = part.quotation?.source;
  if (!source || source.kind !== 'message' || source.artifactFile) return undefined;
  const original = await read(source);
  if (!original) return undefined;
  const parts = messageSourceParts(original.message.content, original.message.contentBlocks);
  const matches = parts.flatMap((candidate) => {
    if (candidate.part.kind === 'quote') return [];
    const raw = part.quotation!.text;
    const range =
      candidate.part.kind === 'code'
        ? locate([candidate], {
            threadId: source.threadId,
            messageId: source.messageId,
            contentRevision: original.result.contentRevision,
            quote: raw,
            reason: 'origin',
          })
        : resolveSharedMarkdownSelection(candidate.text, raw);
    return range ? [{ candidate, start: range.start }] : [];
  });
  if (matches.length !== 1) return undefined;
  return {
    threadId: source.threadId,
    messageId: source.messageId,
    contentRevision: original.result.contentRevision,
    sourceDigest: selectedSourceDigest(original.message),
    speaker: original.result.speaker,
    ...(original.result.speakerLabel ? { speakerLabel: original.result.speakerLabel } : {}),
    timestamp: original.result.timestamp,
    headingPath: selectedMessageHeadings(parts, matches[0].candidate, matches[0].start),
  };
}

export async function verifySelectedMessageQuote(
  input: SelectedMessageSource,
  admitted: AdmittedSelectedSource,
  read: SelectedSourceReader,
): Promise<MessageSourceSelection> {
  if (input.contentRevision !== admitted.result.contentRevision)
    throw new MessageSelectionError('Selected source revision changed');
  const parts = messageSourceParts(admitted.message.content, admitted.message.contentBlocks);
  const sourceDigest = selectedSourceDigest(admitted.message);
  const found = locate(parts, input);
  if (!found) throw new MessageSelectionError('Selected quote is absent or ambiguous; supply its exact part and range');
  const { part, start, end } = found;
  const quotation = part.quotation;
  const origin = quotation ? await quotedOrigin(part, read) : undefined;
  return {
    v: 1,
    quote: input.quote,
    reason: input.reason,
    part: part.part,
    range: { start, end },
    sourceDigest,
    context: selectedMessageContext(part.text, start, end),
    headingPath: selectedMessageHeadings(parts, part, start),
    ...(quotation
      ? {
          quotation: {
            text: quotation.text.slice(0, 2000),
            truncated: quotation.text.length > 2000,
            ...(origin ? { origin } : {}),
          },
          ...(quotation.comment
            ? { comment: { text: quotation.comment.slice(0, 2000), truncated: quotation.comment.length > 2000 } }
            : {}),
        }
      : {}),
  };
}

/** Re-reading preserves the saved interpretation; it does not upgrade an unverified original later. */
export async function readSelectedQuoteProof(
  result: MessageSearchResult,
  read: SelectedSourceReader,
): Promise<MessageSearchResult | null> {
  if (!result.selection) return null;
  const current = await read(result);
  if (
    !current ||
    current.result.contentRevision !== result.contentRevision ||
    selectedSourceDigest(current.message) !== result.selection.sourceDigest
  )
    return null;
  const origin = result.selection.quotation?.origin;
  if (origin) {
    const original = await read(origin);
    if (
      !original ||
      original.result.contentRevision !== origin.contentRevision ||
      selectedSourceDigest(original.message) !== origin.sourceDigest
    )
      return null;
  }
  return {
    ...result,
    threadTitle: current.result.threadTitle,
    speaker: current.result.speaker,
    speakerLabel: current.result.speakerLabel,
    timestamp: current.result.timestamp,
    timelineOrderAt: current.result.timelineOrderAt,
    publiclyQuotable: current.result.publiclyQuotable,
  };
}
