import { createHash, randomUUID } from 'node:crypto';
import type { MessageSearchInput, MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { resolveThreadAccess } from '../cats/services/session/thread-access-policy.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import {
  canQuoteInPublicReply,
  canViewMessage,
  getTimelineOrderTime,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  passesManagedHoldViewerBoundary,
  resolveVisibleReplyParent,
  type Viewer,
} from '../cats/services/stores/visibility.js';
import type { IEvidenceStore, SearchOptions } from './interfaces.js';
import type { MessagePassageCandidate, MessagePassageSearchExecution } from './message-passage-search-types.js';
import { boundMessageSearchResponse, MESSAGE_SEARCH_RESPONSE_BUDGET } from './message-search-budget.js';
import { buildSearchableMessageContent } from './message-search-content.js';

export interface MessageSearchPrincipal {
  userId: string;
  viewer: Viewer;
  /** Bound by authenticated invocation/ingress; never copied from model arguments. */
  source?: { threadId: string; messageId: string };
  /** Shared public reply/prefetch contexts cannot publish unrevealed whispers. */
  publicReply?: boolean;
}

interface MessageSearchServiceDeps {
  evidenceStore: Pick<IEvidenceStore, 'searchMessagePassages' | 'readMessagePassageState'>;
  messageStore: Pick<IMessageStore, 'getById'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
}

type MessageSearchExecutionContext = Pick<SearchOptions, 'signal' | 'deadlineAt'>;

function checkSearchExecution(context: MessageSearchExecutionContext): void {
  context.signal?.throwIfAborted();
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt)
    throw new DOMException('Message search deadline exceeded', 'TimeoutError');
}

export class MessageSearchAccessError extends Error {
  readonly statusCode = 403;
}

function snippet(text: string, source: MessageSearchResult['snippet']['source']): MessageSearchResult['snippet'] {
  const boundaries = [...text.slice(0, 240).matchAll(/[。！？]|[.!?](?=\s|$)|\n/g)];
  const second = boundaries[1];
  const end = Math.min(240, second ? second.index + second[0].length : text.length);
  return { text: text.slice(0, end), start: 0, end, source };
}

function highlight(text: string, query: string): MessageSearchResult['highlights'] {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return [];
  const match = new RegExp(escaped, 'iu').exec(text);
  return match ? [{ start: match.index, end: match.index + match[0].length }] : [];
}

function searchMeta(
  input: MessageSearchInput,
  execution: MessagePassageSearchExecution,
  count: number,
  limit: number,
): MessageSearchResponse['meta'] {
  return {
    scope: input.threadId ? 'thread' : 'global',
    ...(input.threadId ? { threadId: input.threadId } : {}),
    sort: input.sort ?? 'time',
    requestedMode: input.mode ?? 'hybrid',
    effectiveMode: execution.meta.effectiveMode,
    degraded: execution.meta.degraded,
    ...(execution.meta.degradeReason ? { degradeReason: execution.meta.degradeReason } : {}),
    hasMore: count > limit,
    partial: true,
    candidateLimit: execution.meta.candidateLimit,
    semanticCandidatesLimited: execution.meta.semanticCandidatesLimited,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: {
      budgetChars: MESSAGE_SEARCH_RESPONSE_BUDGET,
      serializedChars: 0,
      truncated: false,
      continuation: 'unavailable',
    },
  };
}

/** Only this projection may turn indexed message candidates into readable results. */
export class MessageSearchService {
  constructor(private readonly deps: MessageSearchServiceDeps) {}

  private async readableThreads(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    execution: MessageSearchExecutionContext = {},
  ): Promise<Map<string, Thread>> {
    const rows = input.threadId
      ? [await this.deps.threadStore.get(input.threadId)]
      : await this.deps.threadStore.list(principal.userId);
    const allowed = new Map<string, Thread>();
    for (const thread of rows) {
      checkSearchExecution(execution);
      if (!thread || thread.deletedAt) continue;
      const decision = await resolveThreadAccess({
        threadStore: this.deps.threadStore,
        thread,
        userId: principal.userId,
        request: { resource: 'transcript', action: 'search' },
      });
      if (decision.status === 200) allowed.set(thread.id, thread);
    }
    if (input.threadId && !allowed.has(input.threadId)) throw new MessageSearchAccessError('Thread is not accessible');
    return allowed;
  }

  private async readableMessage(
    ref: { threadId: string; messageId: string },
    principal: MessageSearchPrincipal,
  ): Promise<StoredMessage | null> {
    const message = await resolveVisibleReplyParent(this.deps.messageStore, ref.messageId, {
      threadId: ref.threadId,
      viewer: principal.viewer,
      publicReply: principal.publicReply,
    });
    if (!message || message.id !== ref.messageId || message._tombstone) return null;
    if (message.userId !== principal.userId && !isSystemUserMessage(message)) return null;
    if (!passesManagedHoldViewerBoundary(message, principal.userId)) return null;
    return message;
  }

  private async project(
    candidate: MessagePassageCandidate,
    principal: MessageSearchPrincipal,
    query: string,
  ): Promise<MessageSearchResult | null> {
    const message = await this.readableMessage(candidate, principal);
    if (!message || !Number.isFinite(message.timestamp)) return null;
    // Recheck current thread authority after retrieval/embedding, as grants can change.
    const thread = await this.deps.threadStore.get(candidate.threadId);
    if (!thread || thread.deletedAt) return null;
    const access = await resolveThreadAccess({
      threadStore: this.deps.threadStore,
      thread,
      userId: principal.userId,
      request: { resource: 'transcript', action: 'search' },
    });
    if (access.status !== 200) return null;
    const indexState = this.deps.evidenceStore.readMessagePassageState?.(candidate);
    if (!indexState?.current) return null;
    const canonical = buildSearchableMessageContent({
      content: message.content,
      contentBlocks: message.contentBlocks,
      richBlocks: message.extra?.rich?.blocks,
    });
    if (candidate.content !== canonical) return null;
    const excerpt = message.content.trim() ? snippet(message.content, 'body') : snippet(canonical, 'attachment-text');
    return {
      threadId: thread.id,
      messageId: message.id,
      threadTitle: indexState.suppressThreadTitle ? `原对话 (${thread.id})` : (thread.title ?? thread.id),
      speaker: message.catId ?? 'user',
      timestamp: message.timestamp,
      timelineOrderAt: getTimelineOrderTime(message),
      snippet: excerpt,
      highlights: highlight(excerpt.text, query),
      match: candidate.match,
      contentRevision: createHash('sha256').update(canonical).digest('hex'),
      publiclyQuotable: canQuoteInPublicReply(message),
    };
  }

  private async requireSource(input: MessageSearchInput, principal: MessageSearchPrincipal): Promise<void> {
    if (!principal.source) return;
    try {
      await this.readableThreads({ query: input.query, threadId: principal.source.threadId }, principal);
    } catch (error) {
      if (error instanceof MessageSearchAccessError)
        throw new MessageSearchAccessError('Invocation source thread is not accessible');
      throw error;
    }
    // The authenticated question may still be in flight. Source admission only
    // validates its identity/owner; it does not grant publication of queued bodies.
    const source = await this.deps.messageStore.getById(principal.source.messageId);
    if (
      !source ||
      source.id !== principal.source.messageId ||
      source.threadId !== principal.source.threadId ||
      source.deletedAt ||
      source._tombstone ||
      source.deliveryStatus === 'canceled' ||
      isInternalNonQuotableParent(source) ||
      !canViewMessage(source, principal.viewer) ||
      (source.userId !== principal.userId && !isSystemUserMessage(source)) ||
      !passesManagedHoldViewerBoundary(source, principal.userId)
    )
      throw new MessageSearchAccessError('Invocation source is not accessible');
  }

  private async projectCandidates(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    threads: Map<string, Thread>,
    candidates: MessagePassageCandidate[],
    execution: MessageSearchExecutionContext,
  ): Promise<MessageSearchResult[]> {
    const results: MessageSearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      checkSearchExecution(execution);
      if (
        candidate.docAnchor !== `thread-${candidate.threadId}` ||
        candidate.passageId !== `msg-${candidate.messageId}`
      )
        continue;
      if (!threads.has(candidate.threadId)) continue;
      if (principal.source?.threadId === candidate.threadId && principal.source.messageId === candidate.messageId)
        continue;
      const key = JSON.stringify([candidate.threadId, candidate.messageId]);
      if (seen.has(key)) continue;
      const result = await this.project(candidate, principal, input.query);
      checkSearchExecution(execution);
      if (!result) continue;
      seen.add(key);
      results.push(result);
    }
    if (input.sort !== 'relevance')
      results.sort(
        (a, b) =>
          a.timestamp - b.timestamp || a.threadId.localeCompare(b.threadId) || a.messageId.localeCompare(b.messageId),
      );
    return results;
  }

  async search(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ): Promise<MessageSearchResponse> {
    checkSearchExecution(context);
    const limit = input.limit ?? 20;
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    if (!input.query.trim() || input.query.length > 2000) throw new Error('Invalid message search query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid message search limit');
    const threads = await this.readableThreads(input, principal, context);
    await this.requireSource(input, principal);
    checkSearchExecution(context);
    const reader = this.deps.evidenceStore.searchMessagePassages;
    if (!reader || !this.deps.evidenceStore.readMessagePassageState)
      throw new Error('Message passage retrieval unavailable');
    const execution = await reader.call(this.deps.evidenceStore, input.query, {
      ...context,
      visibleThreadIds: [...threads.keys()],
      threadId: input.threadId,
      sort: input.sort ?? 'time',
      mode: input.mode ?? 'hybrid',
      excludeSource: principal.source,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
    });
    const from = input.dateFrom ? Date.parse(input.dateFrom) : -Infinity;
    const to = input.dateTo
      ? Date.parse(input.dateTo.length === 10 ? `${input.dateTo}T23:59:59.999Z` : input.dateTo)
      : Infinity;
    const results = (await this.projectCandidates(input, principal, threads, execution.passages, context)).filter(
      (hit) => hit.timestamp >= from && hit.timestamp <= to,
    );
    return boundMessageSearchResponse({
      searchId: randomUUID(),
      query: input.query,
      results: results.slice(0, limit),
      meta: searchMeta(input, execution, results.length, limit),
    });
  }
}
