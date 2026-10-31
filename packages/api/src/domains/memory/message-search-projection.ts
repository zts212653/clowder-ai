import { createHash } from 'node:crypto';
import type { MessageSearchResult } from '@cat-cafe/shared';
import { storedMessageSource } from '../cats/services/stores/message-source.js';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import {
  canQuoteInPublicReply,
  getTimelineOrderTime,
  isSystemUserMessage,
} from '../cats/services/stores/visibility.js';
import type { MessagePassageCandidate, MessagePassageIndexState } from './message-passage-search-types.js';
import type { CanonicalSearchCandidate } from './message-search-candidates.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { messageSourceText } from './message-source-text.js';

export function projectMessageSearchSnippet(
  text: string,
  source: MessageSearchResult['snippet']['source'],
  query = '',
): MessageSearchResult['snippet'] {
  const matchAt = query.trim() ? text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase()) : -1;
  const start = matchAt > 160 ? Math.max(0, matchAt - 80) : 0;
  const window = text.slice(start, start + 240);
  const boundaries = [...window.matchAll(/[。！？]|[.!?](?=\s|$)|\n/g)];
  const second = boundaries[1];
  const end = Math.min(
    240,
    second && (matchAt < 0 || start + second.index >= matchAt + query.trim().length)
      ? second.index + second[0].length
      : window.length,
  );
  return { text: text.slice(start, start + end), start, end: start + end, source };
}

/** Locate native evidence in original text, retaining original UTF-16 offsets.
 * Canonical whitespace normalization must never be presented as original byte offsets. */
export function projectQualifiedSnippet(
  body: string,
  canonical: string,
  quote: string,
): MessageSearchResult['snippet'] {
  const escaped = quote
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const original = new RegExp(escaped, 'u').exec(body);
  if (original) return projectMessageSearchSnippet(body, 'body', original[0]);
  return projectMessageSearchSnippet(canonical, 'attachment-text', quote);
}

export function projectMessageSearchHighlights(text: string, query: string): MessageSearchResult['highlights'] {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const match = new RegExp(escaped, 'iu').exec(text);
  return match ? [{ start: match.index, end: match.index + match[0].length }] : [];
}

/** Canonical sender chooses the actor class; stored presentation only supplies display metadata. */
export function projectMessageSearchSpeaker(
  message: StoredMessage & { type?: string },
): Pick<MessageSearchResult, 'speaker' | 'speakerLabel'> {
  const from = message.from;
  if (from?.kind === 'user') return { speaker: 'user' };
  if (from?.kind === 'agent') return { speaker: from.catId };
  if (
    from?.kind === 'system' ||
    isSystemUserMessage(message) ||
    message.sourceParseFailure ||
    message.type === 'system'
  )
    return { speaker: 'system' };
  const source = storedMessageSource(message);
  if (from?.kind === 'plugin' || from?.kind === 'external' || source?.connector || message.type === 'connector') {
    const label = (
      source?.label?.trim() ||
      source?.connector ||
      (from?.kind === 'plugin' ? '插件' : from?.kind === 'external' ? from.connectorId : '外部来源')
    ).slice(0, 80);
    const sender = (
      source?.sender?.name?.trim() || (from?.kind === 'plugin' ? undefined : source?.sender?.id?.trim())
    )?.slice(0, 80);
    return { speaker: 'connector', speakerLabel: sender ? `${label} · ${sender}` : label };
  }
  return { speaker: message.catId ?? 'user' };
}

/** Pure canonical body projection; permission/current-source checks remain with MessageSearchService. */
export function projectCanonicalSearchMessage(
  message: StoredMessage,
  thread: Thread,
  indexState: MessagePassageIndexState,
  candidate: MessagePassageCandidate,
  query: string,
  evidence?: string,
): CanonicalSearchCandidate | null {
  const canonical = buildSearchableMessageContent({
    content: message.content,
    contentBlocks: message.contentBlocks,
    richBlocks: message.extra?.rich?.blocks,
  });
  if (candidate.content !== canonical) return null;
  const visible = messageSourceText(message.content, message.contentBlocks);
  const bodyMatches = query.trim() && visible.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const attachmentMatches =
    !bodyMatches && query.trim() && canonical.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const useBody = visible.trim() && !attachmentMatches;
  const excerpt = evidence
    ? projectQualifiedSnippet(visible, canonical, evidence)
    : useBody
      ? projectMessageSearchSnippet(visible, visible === message.content ? 'body' : 'attachment-text', query)
      : projectMessageSearchSnippet(canonical, 'attachment-text', query);
  if (visible !== message.content) excerpt.source = 'attachment-text';
  return {
    threadId: thread.id,
    messageId: message.id,
    content: canonical,
    candidate,
    contentRevision: createHash('sha256').update(canonical).digest('hex'),
    result: {
      threadId: thread.id,
      messageId: message.id,
      threadTitle: indexState.suppressThreadTitle ? `原对话 (${thread.id})` : (thread.title ?? thread.id),
      ...projectMessageSearchSpeaker(message),
      timestamp: message.timestamp,
      timelineOrderAt: getTimelineOrderTime(message),
      snippet: excerpt,
      highlights: projectMessageSearchHighlights(excerpt.text, query),
      match: candidate.match,
      contentRevision: createHash('sha256').update(canonical).digest('hex'),
      publiclyQuotable: canQuoteInPublicReply(message),
    },
  };
}
