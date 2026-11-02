import { randomUUID } from 'node:crypto';
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
  isAgentReadableManagedHoldMessage,
  isEligibleReplyParent,
  isInternalNonQuotableParent,
  isSystemUserMessage,
  passesManagedHoldViewerBoundary,
  type Viewer,
} from '../cats/services/stores/visibility.js';
import type { IEvidenceStore, SearchOptions } from './interfaces.js';
import {
  attachDecisionSources,
  boundDecisionSearchResponse,
  GitMessageDecisionIndex,
  hasDecisionSourceCoordinate,
  type MessageDecisionIndex,
} from './message-decision-index.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { runNativeQueryBatch } from './message-query-native.js';
import { candidateKey } from './message-query-protocol.js';
import { MessageQueryQualifier } from './message-query-qualifier.js';
import { readMessageSearchAnswerSnapshot } from './message-search-answer-snapshot.js';
import { boundMessageSearchResponse, messageSearchMeta } from './message-search-budget.js';
import { type CanonicalSearchCandidate, collectMessageSearchCandidates } from './message-search-candidates.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { MessageSearchDiagnostics } from './message-search-diagnostics.js';
import { observeMessageSearchExecution } from './message-search-execution.js';
import { projectCanonicalSearchMessage } from './message-search-projection.js';
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
  messageStore: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByThreadAfter'>>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  qualifier?: MessageQueryQualifier;
  onTrace?: (trace: Record<string, unknown>) => void;
  decisionIndex?: MessageDecisionIndex;
}

type MessageSearchExecutionContext = Pick<SearchOptions, 'signal' | 'deadlineAt'> & {
  onTrace?: (trace: Record<string, unknown>) => void;
};

function checkSearchExecution(context: MessageSearchExecutionContext): void {
  context.signal?.throwIfAborted();
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt)
    throw new DOMException('Message search deadline exceeded', 'TimeoutError');
}

export class MessageSearchAccessError extends Error {
  readonly statusCode = 403;
}

/** Only this projection may turn indexed message candidates into readable results. */
export class MessageSearchService {
  private readonly qualifier: MessageQueryQualifier;
  private readonly decisionIndex: MessageDecisionIndex;
  constructor(private readonly deps: MessageSearchServiceDeps) {
    this.qualifier = deps.qualifier ?? new MessageQueryQualifier(runNativeQueryBatch);
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
  ): Promise<StoredMessage | null> {
    const message = await this.deps.messageStore.getById(ref.messageId);
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
    evidence?: string,
    diagnostics?: MessageSearchDiagnostics,
  ): Promise<CanonicalSearchCandidate | null> {
    const source = () => this.readableMessage(candidate, principal);
    const message = await (diagnostics ? diagnostics.measure('source', source) : source());
    if (!message || !Number.isFinite(message.timestamp)) return null;
    // Recheck current thread authority after retrieval/embedding, as grants can change.
    const readThread = () => this.deps.threadStore.get(candidate.threadId);
    const thread = await (diagnostics ? diagnostics.measure('thread', readThread) : readThread());
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
    const projectBody = () => projectCanonicalSearchMessage(message, thread, indexState, candidate, query, evidence);
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
  readAnswerSnapshot(response: MessageSearchResponse, principal: MessageSearchPrincipal, signal?: AbortSignal) {
    return readMessageSearchAnswerSnapshot(response, {
      signal,
      decisionIndex: this.decisionIndex,
      admit: async (result) => {
        const admitted = await this.resolveNavigationReference(result, principal, undefined, signal).catch((error) => {
          if (error instanceof MessageSearchAccessError) return null;
          throw error;
        });
        return !!admitted && !admitted.updated;
      },
    });
  }

  async search(
    input: MessageSearchInput,
    principal: MessageSearchPrincipal,
    context: MessageSearchExecutionContext = {},
  ): Promise<MessageSearchResponse> {
    const deadlineAt = Math.min(context.deadlineAt ?? Infinity, Date.now() + 15_000);
    context = { ...context, deadlineAt };
    const diagnostics = new MessageSearchDiagnostics(context.onTrace ?? this.deps.onTrace);
    const onTrace = diagnostics.trace;
    const observe = observeMessageSearchExecution(onTrace, diagnostics);
    try {
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
          signal: context.signal,
          deadlineAt,
          onReadSnapshot: diagnostics.worker,
          visibleThreadIds: [...threads.keys()],
          threadId: input.threadId,
          sort: input.sort ?? 'time',
          mode: input.mode ?? 'hybrid',
          excludeSource: principal.source,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        }),
      );
      let currentVisibility: Promise<Thread[]> | undefined;
      const authority = {
        list: () => (currentVisibility ??= Promise.resolve(this.deps.threadStore.list(principal.userId))),
      };
      const canonical = await observe('canonical-projection', () =>
        collectMessageSearchCandidates({
          search: input,
          candidates: execution.passages,
          threadIds: new Set(threads.keys()),
          source: principal.source,
          project: (candidate) => this.project(candidate, principal, input.query, authority, undefined, diagnostics),
          diagnostics,
          check: () => checkSearchExecution(context),
        }),
      );
      const qualification = await observe('qualification', () =>
        this.qualifier.qualify(input.query, canonical, {
          userId: principal.userId,
          resultLimit: limit,
          deadlineAt,
          signal: context.signal,
          onTrace,
        }),
      );
      const approved = canonical.filter((row) => qualification.decisions.get(candidateKey(row)) === 'supported');
      const ledgerNeedsRead =
        this.deps.decisionIndex !== undefined ||
        approved.slice(0, limit + 1).some((row) => hasDecisionSourceCoordinate(row.result));
      const decisionIndex = await attachDecisionSources(
        approved.slice(0, limit + 1).map((row) => row.result),
        this.decisionIndex,
        context,
      );
      const results: MessageSearchResult[] = [];
      await observe('final-revalidation', async () => {
        if (qualification.nativeCalls || ledgerNeedsRead) await this.requireSource(input, principal);
        // Refresh the authority snapshot after external inference; the original one
        // cannot keep a revoked grant alive. Only rows needed for the page/witness are reread.
        currentVisibility = undefined;
        for (const row of approved) {
          checkSearchExecution(context);
          // The document lookup is asynchronous too: re-admit after it, even for literal results.
          const fresh =
            qualification.nativeCalls || ledgerNeedsRead
              ? await this.project(
                  row.candidate,
                  principal,
                  input.query,
                  authority,
                  qualification.evidence.get(candidateKey(row)),
                )
              : row;
          if (fresh && fresh.contentRevision === row.contentRevision) {
            if (row.result.decisionSources) fresh.result.decisionSources = row.result.decisionSources;
            results.push(fresh.result);
          } else {
            qualification.meta.supported--;
            qualification.meta.unassessed++;
            qualification.meta.status = 'partial';
          }
          if (results.length > limit) break;
        }
        checkSearchExecution(context);
      });
      const page = results.slice(0, limit);
      checkSearchExecution(context);
      return boundDecisionSearchResponse({
        searchId: randomUUID(),
        query: input.query,
        results: page,
        meta: {
          ...messageSearchMeta(input, execution, results.length, limit),
          qualification: qualification.meta,
          decisionIndex,
        },
      });
    } finally {
      diagnostics.close();
    }
  }
}
