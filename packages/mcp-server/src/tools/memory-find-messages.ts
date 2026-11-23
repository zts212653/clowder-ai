import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { callbackGet, getCallbackConfig } from './callback-tools.js';
import { cappedLimit, type FindContext } from './memory-find-context.js';
import {
  type Candidate,
  ERROR_TEXT_CAP,
  type FindGroup,
  type GroupOutcome,
  type GroupPlan,
} from './memory-find-group.js';
import { canReadMemoryKind } from './memory-read-access.js';
import { messageSearchParams } from './message-search-transport.js';

/**
 * F332 find unification — the messages group: the original canonical message search (resultUnit=message route)
 * with the caller's whole query, thread and time narrowing. Ranking, visibility and match evidence stay with
 * MessageSearchService; results are sources for the reader to judge, never supported verdicts.
 */

export const MESSAGES_LIMIT_BESIDE_DOCS = 5;
const SNIPPET_CAP = 240;
const MATCH_RULE =
  'original message search; each item states lexical terms or semantic retrieval as its match evidence, not a verdict';

export interface MessagesRun {
  query: string;
  limit?: number;
  limitNote?: string;
  threadId?: string;
  dateFrom?: string;
  dateTo?: string;
  mode?: string;
  messageSort?: 'time' | 'relevance';
  agentKeyCatId?: string;
}

export function planMessages(context: FindContext): GroupPlan<MessagesRun> {
  if (context.watcher || !context.query) return { kind: 'skip' };
  if (context.mode === 'continue' && context.continueGroup !== 'messages') return { kind: 'skip' };
  if (context.mode === 'browse') return { kind: 'skip' };
  if (context.scope && !['all', 'threads'].includes(context.scope)) return { kind: 'skip' };
  if (context.dimension && context.dimension !== 'project') return { kind: 'skip' };
  if (context.kinds?.length) return { kind: 'skip' };
  if (!canReadMemoryKind('message') || getCallbackConfig({ agentKeyCatId: context.agentKeyCatId }) === null)
    return { kind: 'skip' };
  const capped = cappedLimit('messages', context.limit);
  const limit = capped.limit ?? (context.mode === 'query' ? MESSAGES_LIMIT_BESIDE_DOCS : undefined);
  return {
    kind: 'run',
    run: {
      query: context.query,
      ...(limit !== undefined ? { limit } : {}),
      ...(capped.note ? { limitNote: capped.note } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      ...(context.lowerBound ? { dateFrom: context.lowerBound } : {}),
      ...(context.dateTo ? { dateTo: context.dateTo } : {}),
      ...(context.retrievalMode ? { mode: context.retrievalMode } : {}),
      ...(context.messageSort ? { messageSort: context.messageSort } : {}),
      ...(context.agentKeyCatId ? { agentKeyCatId: context.agentKeyCatId } : {}),
    },
  };
}

async function fetchMessages(run: MessagesRun, signal: AbortSignal): Promise<GroupOutcome<MessageSearchResponse>> {
  const params = messageSearchParams({
    query: run.query,
    ...(run.limit !== undefined ? { limit: run.limit } : {}),
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.dateFrom ? { dateFrom: run.dateFrom } : {}),
    ...(run.dateTo ? { dateTo: run.dateTo } : {}),
    ...(run.mode ? { mode: run.mode } : {}),
    ...(run.messageSort ? { messageSort: run.messageSort } : {}),
  });
  const result = await callbackGet('/api/callbacks/search-evidence', params, {
    agentKeyCatId: run.agentKeyCatId,
    signal,
  });
  if (signal.aborted) return { status: 'timeout' };
  const text = result.content.map((block) => block.text ?? '').join('\n');
  if (result.isError) return { status: 'failed', error: text.slice(0, ERROR_TEXT_CAP) };
  const response = JSON.parse(text) as MessageSearchResponse;
  if (!Array.isArray(response.results)) return { status: 'failed', error: 'message search returned no results array' };
  return { status: response.results.length > 0 ? 'ok' : 'no_results', data: response };
}

type Projection = 'full' | 'compact' | 'minimal';

function readRefOf(result: MessageSearchResult) {
  return result.readRef ?? { kind: 'message', threadId: result.threadId, messageId: result.messageId };
}

function projectResult(result: MessageSearchResult, projection: Projection): Record<string, unknown> {
  if (projection === 'full') {
    const { highlights: _highlights, ...original } = result;
    return { ...original, readRef: readRefOf(result) };
  }
  const evidence = result.matchEvidence ?? { kind: result.match, terms: [] };
  if (projection === 'minimal')
    return {
      threadTitle: result.threadTitle,
      at: new Date(result.timestamp).toISOString().slice(0, 10),
      match: evidence.kind,
      readRef: readRefOf(result),
    };
  const snippet = result.snippet.text;
  return {
    threadTitle: result.threadTitle,
    speaker: result.speakerLabel ?? result.speaker,
    at: new Date(result.timestamp).toISOString(),
    snippet: snippet.length > SNIPPET_CAP ? `${snippet.slice(0, SNIPPET_CAP - 1)}…` : snippet,
    matchEvidence: evidence,
    readRef: readRefOf(result),
  };
}

function range(response: MessageSearchResponse) {
  const { meta } = response;
  return {
    scope: meta.scope,
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
    sort: meta.sort,
    mode: meta.effectiveMode,
    ...(meta.degraded
      ? { degraded: meta.degraded, ...(meta.degradeReason ? { degradeReason: meta.degradeReason } : {}) }
      : {}),
    ...(meta.partial ? { partial: true } : {}),
    hasMore: meta.hasMore,
    coverage: 'top results only; does not prove the first or every occurrence',
  };
}

export function createMessagesGroup(context: FindContext): FindGroup<MessageSearchResponse> {
  const plan = planMessages(context);
  const run = plan.kind === 'run' ? plan.run : undefined;
  return {
    name: 'messages',
    plan,
    start: (signal) => (run ? fetchMessages(run, signal) : Promise.resolve({ status: 'timeout' })),
    counts: (response) => ({ count: response.results.length, hasNext: response.meta.hasMore }),
    emptyDetail: (response) => ({ range: range(response) }),
    continueArguments: () => ({
      ...(run ? { query: run.query } : {}),
      continueGroup: 'messages',
      ...(run?.threadId ? { threadId: run.threadId } : {}),
      ...(run?.dateFrom ? { dateFrom: run.dateFrom } : {}),
      ...(run?.dateTo ? { dateTo: run.dateTo } : {}),
      ...(run?.mode ? { mode: run.mode } : {}),
      ...(run?.messageSort ? { messageSort: run.messageSort } : {}),
      ...(run?.limit !== undefined ? { limit: run.limit } : {}),
      // The shared Antigravity sidecar selects the caller's identity by agent key; a continuation keeps it.
      ...(run?.agentKeyCatId ? { agentKeyCatId: run.agentKeyCatId } : {}),
    }),
    pages: (outcome) =>
      (['full', 'compact', 'minimal'] as const).map(
        (projection): Candidate => ({
          status: outcome.status,
          text: JSON.stringify({
            group: 'messages',
            status: outcome.status,
            ...(projection !== 'full' ? { projection } : {}),
            match: MATCH_RULE,
            range: range(outcome.data),
            ...(run?.limitNote ? { limitNote: run.limitNote } : {}),
            ...(projection === 'full' && outcome.data.notice ? { notice: outcome.data.notice.summary } : {}),
            items: outcome.data.results.map((result) => projectResult(result, projection)),
            note: 'Open readRef with cat_cafe_read_memory before quoting; contentRevision travels with the full read.',
          }),
        }),
      ),
  };
}
