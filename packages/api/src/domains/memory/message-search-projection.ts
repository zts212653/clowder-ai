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
import type { CanonicalSearchCandidate } from './message-discovery-source.js';
import type { MessagePassageCandidate, MessagePassageIndexState } from './message-passage-search-types.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { messageSearchMatchEvidence } from './message-search-match-evidence.js';
import { projectMessageSearchHighlights, projectMessageSearchSnippet } from './message-search-snippet.js';
import { messageSourceText } from './message-source-text.js';

export { projectMessageSearchHighlights, projectMessageSearchSnippet } from './message-search-snippet.js';

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
  const excerpt = useBody
    ? projectMessageSearchSnippet(visible, visible === message.content ? 'body' : 'attachment-text', query)
    : projectMessageSearchSnippet(canonical, 'attachment-text', query);
  if (visible !== message.content) excerpt.source = 'attachment-text';
  return {
    threadId: thread.id,
    messageId: message.id,
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
      matchEvidence: messageSearchMatchEvidence(query, canonical, candidate.match),
      contentRevision: createHash('sha256').update(canonical).digest('hex'),
      publiclyQuotable: canQuoteInPublicReply(message),
    },
  };
}
