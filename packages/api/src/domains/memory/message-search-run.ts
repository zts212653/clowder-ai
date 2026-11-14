import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MESSAGE_SEARCH_SORT,
  type MessageSearchInput,
  type MessageSearchResponse,
  type MessageSearchResult,
} from '@cat-cafe/shared';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import { KnowledgeResolver } from './KnowledgeResolver.js';
import type { MessageSearchPrincipal } from './MessageSearchService.js';
import {
  attachDecisionSources,
  boundDecisionSearchResponse,
  type MessageDecisionIndex,
} from './message-decision-index.js';
import {
  type CanonicalSearchCandidate,
  compareCanonicalMessages,
  MESSAGE_SEARCH_TIME_WINDOW,
  messageDiscoverySource,
} from './message-discovery-source.js';
import type {
  MessagePassageCandidate,
  MessagePassageSearchExecution,
  MessagePassageSearchOptions,
} from './message-passage-search-types.js';
import { messageSearchMeta } from './message-search-budget.js';
import { MessageSearchDiagnostics } from './message-search-diagnostics.js';
import { observeMessageSearchExecution } from './message-search-execution.js';
import {
  checkSearchExecution,
  type MessageSearchExecutionContext,
  readBeforeSearchCutoff,
} from './message-search-lifetime.js';

interface SearchOperations {
  visible: (context: MessageSearchExecutionContext) => Promise<Map<string, Thread>>;
  requireSource: () => Promise<void>;
  retrieve: (query: string, options: MessagePassageSearchOptions) => Promise<MessagePassageSearchExecution>;
  project: (
    candidate: MessagePassageCandidate,
    diagnostics?: MessageSearchDiagnostics,
  ) => Promise<CanonicalSearchCandidate | null>;
  projectWave: (
    candidates: MessagePassageCandidate[],
    diagnostics: MessageSearchDiagnostics,
  ) => Promise<Array<CanonicalSearchCandidate | null>>;
  resetAuthority: () => void;
  decisionIndex: MessageDecisionIndex;
}

/** One retrieval/admission core. All recall returns ordinary sources; answers consume the separate cat selections. */
export async function runMessageSearch(
  input: MessageSearchInput,
  principal: MessageSearchPrincipal,
  context: MessageSearchExecutionContext,
  ops: SearchOperations,
): Promise<MessageSearchResponse> {
  // Resolve before discovery so admission budget, ordering and metadata agree for direct callers too.
  input = { ...input, sort: input.sort ?? DEFAULT_MESSAGE_SEARCH_SORT };
  const deadlineAt = Math.min(context.deadlineAt ?? Infinity, Date.now() + 15_000);
  context = { ...context, deadlineAt };
  const workCutoff = deadlineAt - 2000;
  const publicationCutoff = deadlineAt - 100;
  const limit = input.limit ?? 20;
  const searchId = randomUUID();
  const diagnostics = new MessageSearchDiagnostics(context.onTrace, { searchId, ownerId: principal.userId });
  const observe = observeMessageSearchExecution(diagnostics.trace, diagnostics);
  let stoppedEarly = false;
  let projectionWaveMs = 0;
  try {
    checkSearchExecution(context);
    const threads = await observe(
      'visibility',
      () => ops.visible(context),
      () => checkSearchExecution(context),
    );
    await observe('source-admission', ops.requireSource, () => checkSearchExecution(context));
    let execution: MessagePassageSearchExecution | undefined;
    const discovery = await observe('canonical-projection', () =>
      KnowledgeResolver.discover(input.query, {
        limit: input.sort === 'relevance' ? limit + 1 : MESSAGE_SEARCH_TIME_WINDOW,
        candidateBudget: 2000,
        signal: context.signal,
        deadlineAt,
        check: () => checkSearchExecution(context),
        ...(input.sort === 'relevance' ? {} : { compare: compareCanonicalMessages }),
        sources: [
          messageDiscoverySource({
            search: input,
            read: async (request) => {
              execution = await observe('retrieval', () =>
                ops.retrieve(input.query, {
                  signal: request.signal,
                  deadlineAt: request.deadlineAt,
                  onReadSnapshot: diagnostics.worker,
                  candidateAudit: diagnostics.candidateEvidence?.request,
                  visibleThreadIds: [...threads.keys()],
                  threadId: input.threadId,
                  sort: input.sort,
                  mode: input.mode ?? 'hybrid',
                  candidateOrder: 'relevance',
                  excludeSource: principal.source,
                  dateFrom: input.dateFrom,
                  dateTo: input.dateTo,
                }),
              );
              return { candidates: execution.passages };
            },
            threadIds: new Set(threads.keys()),
            source: principal.source,
            project: async (candidate) => {
              const row = await ops.project(candidate, diagnostics);
              diagnostics.candidateEvidence?.projection(candidate, row);
              return row;
            },
            projectWave: async (rows) => {
              const projected = await ops.projectWave(rows, diagnostics);
              for (const [index, candidate] of rows.entries())
                diagnostics.candidateEvidence?.projection(candidate, projected[index] ?? null);
              return projected;
            },
            beforeWave: async (read) => {
              if (Date.now() + projectionWaveMs >= workCutoff) {
                stoppedEarly = true;
                return undefined;
              }
              const started = Date.now();
              const work = await readBeforeSearchCutoff(read, workCutoff, context);
              projectionWaveMs = Math.max(projectionWaveMs, Date.now() - started);
              if (work.completed) return work.value;
              stoppedEarly = true;
              return undefined;
            },
            diagnostics,
          }),
        ],
      }),
    );
    const canonical = discovery.items;
    diagnostics.candidateEvidence?.window(canonical);
    if (!execution) throw new Error('Message discovery did not retrieve a source window');
    // Isolate optional mutations: a late ledger read cannot mutate the published rows.
    const labelled = canonical.slice(0, limit + 1).map((row) => ({ ...row.result }));
    const decisionIndex = await observe('decision-sources', async () => {
      if (Date.now() >= workCutoff) return { status: 'unavailable' as const };
      const read = () => attachDecisionSources(labelled, ops.decisionIndex, { ...context, deadlineAt: workCutoff });
      const work = await readBeforeSearchCutoff(read, workCutoff, context);
      return work.completed ? work.value : { status: 'unavailable' as const };
    });
    const results: MessageSearchResult[] = [];
    await observe('final-revalidation', async () => {
      const source = await readBeforeSearchCutoff(ops.requireSource, publicationCutoff, context);
      if (!source.completed) throw new DOMException('Source admission budget exhausted', 'TimeoutError');
      ops.resetAuthority();
      let sourceReadMs = 0;
      for (const row of canonical) {
        checkSearchExecution(context);
        if (Date.now() + sourceReadMs >= publicationCutoff) {
          stoppedEarly = true;
          break;
        }
        const started = Date.now();
        const work = await readBeforeSearchCutoff(() => ops.project(row.candidate), publicationCutoff, context);
        sourceReadMs = Math.max(sourceReadMs, Date.now() - started);
        if (!work.completed) {
          stoppedEarly = true;
          break;
        }
        const fresh = work.value;
        diagnostics.candidateEvidence?.final(row, fresh);
        if (fresh && fresh.contentRevision === row.contentRevision) {
          const facts = labelled.find(
            (item) => item.threadId === row.threadId && item.messageId === row.messageId,
          )?.decisionSources;
          if (decisionIndex.status === 'ready' && facts) fresh.result.decisionSources = facts;
          results.push(fresh.result);
        }
        if (results.length > limit) break;
      }
      checkSearchExecution(context);
    });
    if (!results.length && stoppedEarly) throw new DOMException('No source completed final admission', 'TimeoutError');
    const response = boundDecisionSearchResponse({
      searchId,
      query: input.query,
      results: results.slice(0, limit),
      meta: {
        ...messageSearchMeta(input, execution, results.length, limit),
        resultKind: 'sources',
        hasMore: stoppedEarly || results.length > limit,
        ...(input.sort === 'time'
          ? {
              timeWindow: {
                limit: MESSAGE_SEARCH_TIME_WINDOW,
                admitted: canonical.length,
                complete: canonical.length === MESSAGE_SEARCH_TIME_WINDOW,
              },
            }
          : {}),
        decisionIndex,
      },
    });
    checkSearchExecution(context);
    diagnostics.candidateEvidence?.publish();
    checkSearchExecution(context);
    return response;
  } finally {
    diagnostics.close();
  }
}
