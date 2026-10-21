import { createHash, randomUUID } from 'node:crypto';
import type {
  MessageNavigationAdmission,
  MessageNavigationReference,
  MessageSearchInput,
  MessageSearchResponse,
  MessageSearchResult,
} from '@cat-cafe/shared';
import { resolveThreadAccess } from '../cats/services/session/thread-access-policy.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import {
  canQuoteInPublicReply,
  canViewMessage,
  getTimelineOrderTime,
  isAgentReadableManagedHoldMessage,
  isEligibleReplyParent,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  passesManagedHoldViewerBoundary,
  type Viewer,
} from '../cats/services/stores/visibility.js';
import type { IEvidenceStore, SearchOptions } from './interfaces.js';
import type { MessagePassageCandidate, MessagePassageSearchExecution } from './message-passage-search-types.js';
import { boundMessageSearchResponse, MESSAGE_SEARCH_RESPONSE_BUDGET } from './message-search-budget.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { observeMessageSearchExecution } from './message-search-execution.js';
import {
  projectMessageSearchHighlights,
  projectMessageSearchSnippet,
  projectMessageSearchSpeaker,
} from './message-search-projection.js';

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
    // list(userId) is already the durable visibility index. Reuse this exact
    // admission snapshot rather than re-reading it for every system thread.
    const authority = input.threadId ? this.deps.threadStore : { list: async () => rows.filter((row) => row !== null) };
    for (const thread of rows) {
      checkSearchExecution(execution);
      if (!thread || thread.deletedAt) continue;
      const decision = await resolveThreadAccess({
        threadStore: authority,
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
    const message = await this.deps.messageStore.getById(ref.messageId);
    if (
      !message ||
      message.id !== ref.messageId ||
      message.threadId !== ref.threadId ||
      message._tombstone ||
      message.deletedAt
    )
      return null;
    // Owner-bound delivered command wakes are readable system notices, as in
    // callback History/drill. They do not grant access to other system rows.
    const managedHold = isAgentReadableManagedHoldMessage(message) && message.userId === principal.userId;
    if (!managedHold && !isEligibleReplyParent(message, { threadId: ref.threadId, viewer: principal.viewer }))
      return null;
    if (!canViewMessage(message, principal.viewer)) return null;
    if (principal.publicReply && !canQuoteInPublicReply(message)) return null;
    if (message.userId !== principal.userId && !isSystemUserMessage(message)) return null;
    if (!passesManagedHoldViewerBoundary(message, principal.userId)) return null;
    return message;
  }

  private async project(
    candidate: MessagePassageCandidate,
    principal: MessageSearchPrincipal,
    query: string,
    authority: Pick<IThreadStore, 'list'> = this.deps.threadStore,
  ): Promise<MessageSearchResult | null> {
    const message = await this.readableMessage(candidate, principal);
    if (!message || !Number.isFinite(message.timestamp)) return null;
    // Recheck current thread authority after retrieval/embedding, as grants can change.
    const thread = await this.deps.threadStore.get(candidate.threadId);
    if (!thread || thread.deletedAt) return null;
    const access = await resolveThreadAccess({
      threadStore: authority,
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
    const bodyMatches = query.trim() && message.content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const attachmentMatches =
      !bodyMatches && query.trim() && canonical.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const useBody = message.content.trim() && !attachmentMatches;
    const excerpt = useBody
      ? projectMessageSearchSnippet(message.content, 'body', query)
      : projectMessageSearchSnippet(canonical, 'attachment-text', query);
    return {
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
    const from = input.dateFrom ? Date.parse(input.dateFrom) : -Infinity;
    const to = input.dateTo
      ? Date.parse(input.dateTo.length === 10 ? `${input.dateTo}T23:59:59.999Z` : input.dateTo)
      : Infinity;
    const limit = input.limit ?? 20;
    // A new snapshot after retrieval preserves grant revocation checks. It is
    // read lazily only if current candidates need the user-index authority.
    let currentVisibility: Promise<Thread[]> | undefined;
    const authority = {
      list: (userId: string) => (currentVisibility ??= Promise.resolve(this.deps.threadStore.list(userId))),
    };
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
      const result = await this.project(candidate, principal, input.query, authority);
      checkSearchExecution(execution);
      if (!result) continue;
      seen.add(key);
      if (!(result.timestamp >= from && result.timestamp <= to)) continue;
      results.push(result);
      // Relevance order is already fixed by retrieval. One additional verified
      // result proves hasMore; unreadable or out-of-window rows never count.
      // Time order still requires the complete canonical timestamp projection.
      if (input.sort === 'relevance' && results.length > limit) break;
    }
    if (input.sort !== 'relevance')
      results.sort(
        (a, b) =>
          a.timestamp - b.timestamp || a.threadId.localeCompare(b.threadId) || a.messageId.localeCompare(b.messageId),
      );
    return results;
  }

  /** Re-admit exact coordinates at click time without reranking a saved result collection. */
  async resolveNavigationReference(
    ref: MessageNavigationReference,
    principal: MessageSearchPrincipal,
  ): Promise<MessageNavigationAdmission | null> {
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    await this.readableThreads({ query: 'navigation', threadId: ref.threadId }, principal);
    await this.requireSource({ query: 'navigation' }, principal);
    // Returning to the original thread still works if its original message was deleted.
    if (!ref.messageId) return { status: 'available', target: { threadId: ref.threadId }, updated: false };
    if (principal.source?.threadId === ref.threadId && principal.source.messageId === ref.messageId) return null;
    const exactRef = { threadId: ref.threadId, messageId: ref.messageId };
    const message = await this.readableMessage(exactRef, principal);
    if (!message) return null;
    const content = buildSearchableMessageContent({
      content: message.content,
      contentBlocks: message.contentBlocks,
      richBlocks: message.extra?.rich?.blocks,
    });
    const projected = await this.project(
      {
        ...exactRef,
        docAnchor: `thread-${ref.threadId}`,
        passageId: `msg-${ref.messageId}`,
        content,
        match: 'lexical',
      },
      principal,
      '',
    );
    if (!projected) return null;
    return {
      status: 'available',
      target: { ...exactRef, contentRevision: projected.contentRevision },
      updated: ref.contentRevision !== undefined && ref.contentRevision !== projected.contentRevision,
    };
  }

  async search(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ): Promise<MessageSearchResponse> {
    const observe = observeMessageSearchExecution();
    checkSearchExecution(context);

    const limit = input.limit ?? 20;
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    if (!input.query.trim() || input.query.length > 2000) throw new Error('Invalid message search query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid message search limit');
    const threads = await observe(
      'visibility',
      () => this.readableThreads(input, principal, context),
      () => checkSearchExecution(context),
    );
    await observe(
      'source-admission',
      () => this.requireSource(input, principal),
      () => checkSearchExecution(context),
    );
    const reader = this.deps.evidenceStore.searchMessagePassages;
    if (!reader || !this.deps.evidenceStore.readMessagePassageState)
      throw new Error('Message passage retrieval unavailable');
    const execution = await observe('retrieval', () =>
      reader.call(this.deps.evidenceStore, input.query, {
        ...context,
        visibleThreadIds: [...threads.keys()],
        threadId: input.threadId,
        sort: input.sort ?? 'time',
        mode: input.mode ?? 'hybrid',
        excludeSource: principal.source,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
      }),
    );
    const results = await observe('canonical-projection', () =>
      this.projectCandidates(input, principal, threads, execution.passages, context),
    );
    return boundMessageSearchResponse({
      searchId: randomUUID(),
      query: input.query,
      results: results.slice(0, limit),
      meta: searchMeta(input, execution, results.length, limit),
    });
  }
}
