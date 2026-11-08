import type {
  MessageNavigationAdmission,
  MessageNavigationReference,
  MessageSearchInput,
  MessageSearchResponse,
  MessageSearchResult,
  SelectedMessageSource,
} from '@cat-cafe/shared';
import { resolveThreadAccess } from '../cats/services/session/thread-access-policy.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import {
  canQuoteInPublicReply,
  canViewMessage,
  isAgentReadableManagedHoldMessage,
  isEligibleReplyParent,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  passesManagedHoldViewerBoundary,
  type Viewer,
} from '../cats/services/stores/visibility.js';
import type { IEvidenceStore } from './interfaces.js';
import { runMessageAnswerSelection } from './message-answer-selection-run.js';
import { GitMessageDecisionIndex, type MessageDecisionIndex } from './message-decision-index.js';
import type { CanonicalSearchCandidate } from './message-discovery-source.js';
import { messageDiscoverySource } from './message-discovery-source.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { readMessageSearchAnswerSnapshot } from './message-search-answer-snapshot.js';
import { type CanonicalWaveSources, readCanonicalSearchWave } from './message-search-canonical-wave.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import type { MessageSearchDiagnostics } from './message-search-diagnostics.js';
import {
  checkSearchExecution,
  type MessageSearchExecutionContext,
  readBeforeSearchCutoff,
} from './message-search-lifetime.js';
import { projectCanonicalSearchMessage } from './message-search-projection.js';
import { runMessageSearch } from './message-search-run.js';
import { readSelectedQuoteProof, type SelectedSourceReader } from './message-selected-quote.js';
import type { SelectedSourceReadFence, SelectedSourceReference } from './message-selected-read-fence.js';
import {
  createSelectedSourceReader,
  type SelectedSourceSnapshot,
  withSelectedSourceSnapshot,
} from './message-selected-source.js';
import { readMessageSourceContext } from './message-source-context.js';

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
  messageStore: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByThreadAfter' | 'getByIds'>>;
  threadStore: Pick<IThreadStore, 'get' | 'list' | 'getMany'>;
  onTrace?: (trace: Record<string, unknown>) => void;
  decisionIndex?: MessageDecisionIndex;
  selectedSourceReadFence?: SelectedSourceReadFence;
}

export class MessageSearchAccessError extends Error {
  readonly statusCode = 403;
}

/** Only this projection may turn indexed message candidates into readable results. */
export class MessageSearchService {
  private readonly decisionIndex: MessageDecisionIndex;
  constructor(private readonly deps: MessageSearchServiceDeps) {
    this.decisionIndex = deps.decisionIndex ?? new GitMessageDecisionIndex();
  }

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
    messages?: CanonicalWaveSources['messages'],
  ): Promise<StoredMessage | null> {
    const message = messages ? messages.get(ref.messageId) : await this.deps.messageStore.getById(ref.messageId);
    if (
      !message ||
      message.id !== ref.messageId ||
      message.threadId !== ref.threadId ||
      message.recall ||
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
    diagnostics?: MessageSearchDiagnostics,
    wave?: CanonicalWaveSources,
  ): Promise<CanonicalSearchCandidate | null> {
    const source = () => this.readableMessage(candidate, principal, wave?.messages);
    const message = await (diagnostics && !wave ? diagnostics.measure('source', source) : source());
    if (!message || !Number.isFinite(message.timestamp)) return null;
    // Recheck current thread authority after retrieval/embedding, as grants can change.
    const readThread = () => wave?.threads.get(candidate.threadId) ?? this.deps.threadStore.get(candidate.threadId);
    const thread = await (diagnostics && !wave ? diagnostics.measure('thread', readThread) : readThread());
    if (!thread || thread.deletedAt) return null;
    const readAccess = () =>
      resolveThreadAccess({
        threadStore: authority,
        thread,
        userId: principal.userId,
        request: { resource: 'transcript', action: 'search' },
      });
    const access = await (diagnostics ? diagnostics.measure('access', readAccess) : readAccess());
    if (access.status !== 200) return null;
    const readState = () => this.deps.evidenceStore.readMessagePassageState?.(candidate);
    const indexState = diagnostics ? diagnostics.sync('state', readState) : readState();
    if (!indexState?.current) return null;
    const projectBody = () => projectCanonicalSearchMessage(message, thread, indexState, candidate, query);
    return diagnostics ? diagnostics.sync('projection', projectBody) : projectBody();
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

  /** Re-admit exact coordinates at click time without reranking a saved result collection. */
  async resolveNavigationReference(
    ref: MessageNavigationReference,
    principal: MessageSearchPrincipal,
    contextCount?: number,
    signal?: AbortSignal,
  ): Promise<MessageNavigationAdmission | null> {
    signal?.throwIfAborted();
    if (
      contextCount !== undefined &&
      (!ref.messageId || !Number.isInteger(contextCount) || contextCount < 0 || contextCount > 3)
    )
      throw new Error('Invalid source context request');
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
    const admission: MessageNavigationAdmission = {
      status: 'available',
      target: { ...exactRef, contentRevision: projected.result.contentRevision },
      updated: ref.contentRevision !== undefined && ref.contentRevision !== projected.result.contentRevision,
    };
    if (contextCount === undefined) return admission;
    const after = this.deps.messageStore.getByThreadAfter;
    if (!after) throw new Error('Source context reader unavailable');
    return readMessageSourceContext({
      admission,
      message,
      count: contextCount,
      signal,
      after: async (threadId, messageId, limit) =>
        after.call(this.deps.messageStore, threadId, messageId, limit, principal.userId),
      readable: (coordinate) => this.readableMessage(coordinate, principal),
      revalidate: () => this.resolveNavigationReference(ref, principal, undefined, signal),
    });
  }

  /** Re-admit an existing answer snapshot without retrieval, qualification or provider work. */
  async readAnswerSnapshot(
    response: MessageSearchResponse,
    principal: MessageSearchPrincipal,
    signal?: AbortSignal,
    deadlineAt?: number,
    finalRead?: { references: readonly SelectedSourceReference[]; validate: () => Promise<boolean> },
  ) {
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    const cutoff = Math.min(deadlineAt ?? Infinity, Date.now() + 15000);
    const unavailable = () => ({
      response: { ...response, results: [], meta: { ...response.meta, partial: true } },
      changedSources: response.results.length,
      decisionUpdated: false,
    });
    const read = async (snapshot?: SelectedSourceSnapshot) => {
      const result = await readMessageSearchAnswerSnapshot(response, {
        signal,
        deadlineAt: cutoff,
        requireSource: () => this.requireSource({ query: response.query }, principal),
        decisionIndex: this.decisionIndex,
        project: async (result) => {
          if (result.selection) return readSelectedQuoteProof(result, this.selectedSourceReader(principal, snapshot));
          const admitted = await this.resolveNavigationReference(result, principal, undefined, signal).catch(
            (error) => {
              if (error instanceof MessageSearchAccessError) return null;
              throw error;
            },
          );
          return admitted && !admitted.updated ? { ...result } : null;
        },
      });
      return finalRead && !(await finalRead.validate()) ? unavailable() : result;
    };
    if (!response.results.some((row) => row.selection)) return read();
    const work = await readBeforeSearchCutoff(
      async (lifetime) => {
        const result = await withSelectedSourceSnapshot(
          response.results,
          principal,
          this.deps.messageStore,
          this.deps.threadStore,
          read,
          lifetime,
          this.deps.selectedSourceReadFence,
          finalRead?.references,
        );
        // A failed witness never turns a revoked invocation source into partial success.
        if (result === null && principal.source) await this.requireSource({ query: response.query }, principal);
        return result;
      },
      cutoff - 250,
      { signal, deadlineAt: cutoff },
    );
    if (!work.completed) throw new DOMException('Answer source verification deadline exceeded', 'TimeoutError');
    return work.value ?? unavailable();
  }

  /** Known coordinates use exactly the search projection's visibility/current-index/title policy. */
  private selectedSourceReader(
    principal: MessageSearchPrincipal,
    snapshot?: SelectedSourceSnapshot,
  ): SelectedSourceReader {
    return createSelectedSourceReader(
      principal,
      {
        readable: (ref, messages) => this.readableMessage(ref, principal, messages),
        thread: async (id) => this.deps.threadStore.get(id),
        project: (candidate, wave, authority) =>
          this.project(candidate, principal, '', authority ?? this.deps.threadStore, undefined, wave),
      },
      snapshot,
    );
  }

  selectAnswer(
    query: string,
    selections: SelectedMessageSource[],
    catId: string,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ) {
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    return runMessageAnswerSelection(query, selections, catId, {
      read: this.selectedSourceReader(principal),
      revalidateAll: async (results, lifetime) =>
        (await withSelectedSourceSnapshot(
          results,
          principal,
          this.deps.messageStore,
          this.deps.threadStore,
          async (snapshot) => {
            const read = this.selectedSourceReader(principal, snapshot);
            const current: MessageSearchResult[] = [];
            for (const result of results) {
              const row = await readSelectedQuoteProof(result, read);
              if (row) current.push(row);
            }
            await this.requireSource({ query }, principal);
            return current;
          },
          lifetime,
          this.deps.selectedSourceReadFence,
        )) ?? [],
      requireSource: () => this.requireSource({ query }, principal),
      decisionIndex: this.decisionIndex,
      context,
    });
  }

  /** Ordinary recall returns current readable sources without inference. */
  discoverySource(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ) {
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    if (!input.query.trim() || input.query.length > 2000) throw new Error('Invalid message search query');
    const threadIds = new Set<string>();
    let lifetime = context;
    const source = messageDiscoverySource({
      search: input,
      threadIds,
      source: principal.source,
      read: async (request) => {
        lifetime = {
          ...context,
          signal: request.signal ?? context.signal,
          deadlineAt: Math.min(request.deadlineAt ?? Infinity, context.deadlineAt ?? Infinity, Date.now() + 15_000),
        };
        checkSearchExecution(lifetime);
        const threads = await this.readableThreads(input, principal, lifetime);
        for (const id of threads.keys()) threadIds.add(id);
        await this.requireSource(input, principal);
        const reader = this.deps.evidenceStore.searchMessagePassages;
        if (!reader || !this.deps.evidenceStore.readMessagePassageState)
          throw new Error('Message passage retrieval unavailable');
        const result = await reader.call(this.deps.evidenceStore, input.query, {
          signal: lifetime.signal,
          deadlineAt: lifetime.deadlineAt,
          visibleThreadIds: [...threadIds],
          threadId: input.threadId,
          excludeSource: principal.source,
          mode: input.mode ?? 'hybrid',
          sort: 'relevance',
          candidateOrder: 'relevance',
          candidateLimit: Math.min(2000, request.limit),
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        });
        return { candidates: result.passages, truncated: result.meta.truncated };
      },
      project: (candidate) => this.project(candidate, principal, input.query),
    });
    return {
      ...source,
      revalidate: async (row: CanonicalSearchCandidate) => {
        checkSearchExecution(lifetime);
        await this.requireSource(input, principal);
        const current = await this.project(row.candidate, principal, input.query);
        return current?.contentRevision === row.contentRevision ? current : null;
      },
    };
  }

  async search(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ): Promise<MessageSearchResponse> {
    const limit = input.limit ?? 20;
    if (!principal.userId) throw new MessageSearchAccessError('Search identity is not accessible');
    if (!input.query.trim() || input.query.length > 2000) throw new Error('Invalid message search query');
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid message search limit');
    let currentVisibility: Promise<Thread[]> | undefined;
    const authority = {
      list: () => (currentVisibility ??= Promise.resolve(this.deps.threadStore.list(principal.userId))),
    };
    return runMessageSearch(
      input,
      principal,
      { ...context, onTrace: context.onTrace ?? this.deps.onTrace },
      {
        visible: (execution) => this.readableThreads(input, principal, execution),
        requireSource: () => this.requireSource(input, principal),
        retrieve: (query, options) => {
          const reader = this.deps.evidenceStore.searchMessagePassages;
          if (!reader || !this.deps.evidenceStore.readMessagePassageState)
            throw new Error('Message passage retrieval unavailable');
          return reader.call(this.deps.evidenceStore, query, options);
        },
        project: (candidate, diagnostics) => this.project(candidate, principal, input.query, authority, diagnostics),
        projectWave: async (candidates, diagnostics) => {
          const wave = await readCanonicalSearchWave(
            candidates,
            this.deps.messageStore,
            this.deps.threadStore,
            diagnostics,
          );
          return Promise.all(
            candidates.map((candidate) =>
              this.project(candidate, principal, input.query, authority, diagnostics, wave),
            ),
          );
        },
        resetAuthority: () => {
          currentVisibility = undefined;
        },
        decisionIndex: this.decisionIndex,
      },
    );
  }
}
