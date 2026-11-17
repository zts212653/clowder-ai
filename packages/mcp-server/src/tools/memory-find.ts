import {
  extractAppendedRecallMetaBlock,
  formatRecallMeta,
  isValidRecentSince,
  recentSinceToIso,
  stripAppendedRecallMetaBlock,
} from '@cat-cafe/shared';
import type { ToolResult } from './file-tools.js';
import { errorResult } from './file-tools.js';
import { cappedLimit, type FindContext, isExplicitDocsOnly } from './memory-find-context.js';
import { createGraphGroup } from './memory-find-graph.js';
import { type FindGroup, type GroupName, type GroupRender, GroupRun } from './memory-find-group.js';
import { createMattersGroup } from './memory-find-matters.js';
import { createMessagesGroup } from './memory-find-messages.js';
import { createRecentGroup } from './memory-find-recent.js';
import { isWatcherMemoryContext } from './memory-read-access.js';

/**
 * F332 find unification: one find entry mechanically forwards the caller's clue to every group this identity could
 * already query and that can honour the whole input and its narrowing. Groups run in parallel, report their own
 * status/range/continuation, and share one bounded response. No index, ref store or persistent state is added; each
 * original owner keeps authority, visibility and versions. Contract: docs/architecture/memory/find-entry.md.
 */

/** Same total as the family-wide memory reader budget (tool-response-budget.ts). */
export const FIND_RESPONSE_CHAR_BUDGET = 24_000;
/** Room kept for the final recall sidecar when docs do not run. */
const META_RESERVE = 400;

export interface FindInput {
  query?: string;
  limit?: number;
  scope?: string;
  resultUnit?: string;
  dimension?: string;
  threadId?: string;
  dateFrom?: string;
  dateTo?: string;
  since?: string;
  kinds?: readonly string[];
  coverage_offset?: number;
  matterCursor?: string;
  continueGroup?: GroupName;
  mode?: string;
  messageSort?: 'time' | 'relevance';
  agentKeyCatId?: string;
  graphDepth?: number;
  graphRelations?: readonly string[];
}

export interface DocsGroupOptions {
  /** Resolves the character budget this group may render into (the original page budget less sibling statuses). */
  charBudget: () => Promise<number>;
  /** Per-group page size after applying the docs maximum. */
  limit?: number;
  /** Exact lower time bound resolved from since. */
  dateFrom?: string;
}

export type DocsGroupSearch = (query: string, options: DocsGroupOptions) => Promise<ToolResult>;

const textOf = (result: ToolResult) => result.content.map((block) => block.text ?? '').join('\n');
const boundLabel = (query: string) => (query.length <= 80 ? query : `${query.slice(0, 79)}…`);
/** Text blocks are joined by newlines when a host concatenates them; count those too. */
const separators = (blocks: number) => Math.max(0, blocks - 1);

function docsHeaderStatus(result: ToolResult): string {
  if (result.isError) return 'failed (see docs section)';
  const text = textOf(result);
  if (/No results found/.test(text)) return 'no_results';
  const found = /Found (\d+) result/.exec(text);
  return found ? `ok (${found[1]} result(s))` : 'ok';
}

function groupHeaderStatus(render: GroupRender): string {
  if (render.status === 'ok') return `${render.group} → ok (${render.count}${render.hasNext ? ', more' : ''})`;
  return `${render.group} → ${render.status}`;
}

function findInputError(message: string): ToolResult {
  return errorResult(
    [
      message,
      formatRecallMeta({ resultStatus: 'error', resultCount: null, readNextHint: 'Fix the arguments and retry.' }),
    ].join('\n'),
  );
}

/** The caller's input as one context for every group's plan, or the input error to return before any request. */
export function buildFindContext(input: FindInput): FindContext | string {
  if (input.since && !isValidRecentSince(input.since))
    return 'since must be like 7d, 24h or an ISO 8601 date (2026-05-01, 2026-05-01T08:00Z); relative windows take 1–5 digits.';
  if (input.since && input.dateFrom) return 'Give one lower time bound: since or dateFrom, not both.';
  if (input.continueGroup && input.matterCursor && input.continueGroup !== 'matters')
    return 'matterCursor continues the matters group only.';
  const query = input.query?.trim() ? input.query : undefined;
  const mode = input.continueGroup || input.matterCursor ? 'continue' : query ? 'query' : 'browse';
  const lowerBound = input.since ? recentSinceToIso(input.since) : input.dateFrom;
  return {
    mode,
    ...(query ? { query } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.resultUnit ? { resultUnit: input.resultUnit } : {}),
    ...(input.dimension ? { dimension: input.dimension } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
    ...(input.dateTo ? { dateTo: input.dateTo } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.kinds?.length ? { kinds: input.kinds } : {}),
    ...(input.coverage_offset != null ? { coverageOffset: input.coverage_offset } : {}),
    ...(input.matterCursor ? { matterCursor: input.matterCursor } : {}),
    ...(input.continueGroup ? { continueGroup: input.continueGroup } : {}),
    ...(lowerBound ? { lowerBound } : {}),
    ...(input.mode ? { retrievalMode: input.mode } : {}),
    ...(input.messageSort ? { messageSort: input.messageSort } : {}),
    ...(input.agentKeyCatId ? { agentKeyCatId: input.agentKeyCatId } : {}),
    ...(input.graphDepth !== undefined ? { graphDepth: input.graphDepth } : {}),
    ...(input.graphRelations?.length ? { graphRelations: input.graphRelations } : {}),
    watcher: isWatcherMemoryContext(),
  };
}

type DocsPlan = { kind: 'run' } | { kind: 'not_covered'; reason: string } | { kind: 'none' };

const EXPLICIT_DOCS_ONLY = 'resultUnit and coverage_offset select the original document search alone';

function explicitDocsOnlyBlocker(context: FindContext, docs: DocsPlan): string {
  if (docs.kind === 'not_covered') return `it cannot keep this range (docs: ${docs.reason})`;
  if (context.mode === 'continue') return 'it cannot reopen another group (drop continueGroup / matterCursor)';
  if (context.watcher) return 'this connection has no document search';
  return 'it needs query text';
}

function planDocs(context: FindContext): DocsPlan {
  if (context.mode !== 'query' || context.watcher) return { kind: 'none' };
  if (context.scope === 'trajectories') return { kind: 'not_covered', reason: 'trajectories_is_a_browse_scope' };
  if (context.kinds?.length) return { kind: 'not_covered', reason: 'kinds_filter_unsupported' };
  return { kind: 'run' };
}

const GROUP_FACTORIES: Readonly<Record<GroupName, (context: FindContext) => FindGroup>> = {
  messages: createMessagesGroup as (context: FindContext) => FindGroup,
  graph: createGraphGroup as (context: FindContext) => FindGroup,
  matters: createMattersGroup as (context: FindContext) => FindGroup,
  recent: createRecentGroup as (context: FindContext) => FindGroup,
};

function groupsFor(context: FindContext): FindGroup[] {
  const names: GroupName[] =
    context.mode === 'query'
      ? ['messages', 'graph', 'matters']
      : context.mode === 'browse'
        ? ['recent', 'matters']
        : [context.continueGroup ?? 'matters'];
  return names.map((name) => GROUP_FACTORIES[name](context));
}

async function docsAlone(query: string, context: FindContext, searchDocs: DocsGroupSearch): Promise<ToolResult> {
  const limit = cappedLimit('docs', context.limit);
  const notice = limit.note ? `ℹ️ ${limit.note}.` : undefined;
  const docs = await searchDocs(query, {
    charBudget: async () => FIND_RESPONSE_CHAR_BUDGET - (notice ? notice.length + 1 : 0),
    ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
    ...(context.since && context.lowerBound ? { dateFrom: context.lowerBound } : {}),
  });
  return notice ? { ...docs, content: [{ type: 'text', text: notice }, ...docs.content] } : docs;
}

/** Groups render in order; each leaves room for the smallest honest forms of the groups after it. */
async function renderInOrder(runs: GroupRun[], left: number, alone: boolean): Promise<GroupRender[]> {
  const minima = await Promise.all(runs.map((run) => run.minimalChars()));
  const renders: GroupRender[] = [];
  let room = left;
  for (const [index, run] of runs.entries()) {
    const reserve = minima.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const render = await run.render({ budgetChars: room - reserve, alone });
    room -= render.text.length;
    renders.push(render);
  }
  return renders;
}

async function docsWithGroups(
  query: string,
  context: FindContext,
  searchDocs: DocsGroupSearch,
  runs: GroupRun[],
): Promise<ToolResult> {
  const limit = cappedLimit('docs', context.limit);
  const settle = () => {
    for (const run of runs) run.othersSettled();
  };
  // The docs page keeps the original budget less only the other groups' smallest honest forms for their actual
  // outcomes; a docs page that still does not fit changes representation, never rows (see the docs renderers).
  const docs = await searchDocs(query, {
    ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
    ...(context.since && context.lowerBound ? { dateFrom: context.lowerBound } : {}),
    charBudget: async () => {
      settle();
      const minima = await Promise.all(runs.map((run) => run.minimalChars()));
      return FIND_RESPONSE_CHAR_BUDGET - minima.reduce((sum, value) => sum + value, 0) - separators(runs.length + 3);
    },
  });
  settle();
  const docsText = textOf(docs);
  const meta = extractAppendedRecallMetaBlock(docsText);
  const docsBody = stripAppendedRecallMetaBlock(docsText).trimEnd();
  const blocks = runs.length + (meta ? 2 : 1);
  const left = FIND_RESPONSE_CHAR_BUDGET - docsBody.length - (meta?.length ?? 0) - separators(blocks);
  const renders = await renderInOrder(runs, left, false);
  const used = renders.reduce((sum, render) => sum + render.text.length, 0);
  const header = `🔎 Find for ${JSON.stringify(boundLabel(query))}: docs → ${docsHeaderStatus(docs)} · ${renders.map(groupHeaderStatus).join(' · ')}${limit.note ? ` (${limit.note})` : ''}`;
  const content: ToolResult['content'] = [
    ...(header.length + 1 <= left - used ? [{ type: 'text' as const, text: header }] : []),
    { type: 'text', text: docsBody },
    ...renders.map((render) => ({ type: 'text' as const, text: render.text })),
    // The docs recall sidecar stays the final block, so existing recall telemetry keeps parsing it.
    ...(meta ? [{ type: 'text' as const, text: meta }] : []),
  ];
  return docs.isError && !renders.some((render) => render.status === 'ok') ? { content, isError: true } : { content };
}

function aloneRecallStatus(renders: GroupRender[]): 'counted' | 'no_results' | 'timeout' | 'error' {
  if (renders.some((render) => render.status === 'ok')) return 'counted';
  if (renders.some((render) => render.status === 'no_results')) return 'no_results';
  if (renders.some((render) => render.status === 'timeout')) return 'timeout';
  return 'error';
}

async function groupsAlone(
  context: FindContext,
  runs: GroupRun[],
  docsReason: string | undefined,
): Promise<ToolResult> {
  const docsBlock = docsReason
    ? JSON.stringify({ group: 'docs', status: 'not_covered', reason: docsReason })
    : undefined;
  const blocks = runs.length + (docsBlock ? 3 : 2);
  const left = FIND_RESPONSE_CHAR_BUDGET - META_RESERVE - (docsBlock?.length ?? 0) - separators(blocks);
  const renders = await renderInOrder(runs, left, true);
  const subject = context.query ? `for ${JSON.stringify(boundLabel(context.query))}` : '(no query: browse)';
  const docsPart = docsBlock
    ? 'docs → not_covered · '
    : context.watcher
      ? ''
      : context.mode === 'continue'
        ? 'docs → not run (continuation) · '
        : 'docs → not run (text matching needs a query) · ';
  const pages = renders.filter((render) => render.status === 'ok' || render.status === 'no_results');
  const meta = formatRecallMeta({
    resultStatus: aloneRecallStatus(renders),
    resultCount: pages.length ? pages.reduce((sum, render) => sum + render.count, 0) : null,
    readNextHint: pages.length
      ? 'Open a readRef with cat_cafe_read_memory; pass next.arguments unchanged to continue a group.'
      : 'No page was returned; see each group status and retry when it is retryable.',
  });
  // Separate blocks: each group block stays pure JSON for its consumers (watcher compaction, parsers).
  const content: ToolResult['content'] = [
    { type: 'text', text: `🔎 Find ${subject}: ${docsPart}${renders.map(groupHeaderStatus).join(' · ')}` },
    ...(docsBlock ? [{ type: 'text' as const, text: docsBlock }] : []),
    ...renders.map((render) => ({ type: 'text' as const, text: render.text })),
    { type: 'text', text: meta },
  ];
  // No group produced a page: callers keep error and retry semantics (never a read).
  return pages.length ? { content } : { content, isError: true };
}

export async function runFind(
  input: FindInput,
  searchDocs: DocsGroupSearch,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const context = buildFindContext(input);
  if (typeof context === 'string') return findInputError(context);
  const docs = planDocs(context);
  // An explicit result unit or a docs continuation keeps its original single-group response, or is an input error:
  // it never falls into another group (F1 boundary).
  if (isExplicitDocsOnly(context)) {
    if (docs.kind === 'run') return docsAlone(context.query as string, context, searchDocs);
    return findInputError(`${EXPLICIT_DOCS_ONLY}; ${explicitDocsOnlyBlocker(context, docs)}.`);
  }
  const groups = groupsFor(context).filter((group) => group.plan.kind !== 'skip');
  if (groups.length === 0) {
    if (docs.kind === 'run') return docsAlone(context.query as string, context, searchDocs);
    if (context.mode === 'continue')
      return findInputError('This continuation reopens a group this connection or range cannot query.');
    return findInputError(
      context.query
        ? `No find group of this connection accepts this range${docs.kind === 'not_covered' ? ` (docs: ${docs.reason})` : ''}.`
        : 'Find needs query text here: no group of this connection can browse without a query.',
    );
  }
  const runs = groups.map((group) => new GroupRun(group, signal));
  try {
    if (docs.kind === 'run') return await docsWithGroups(context.query as string, context, searchDocs, runs);
    return await groupsAlone(context, runs, docs.kind === 'not_covered' ? docs.reason : undefined);
  } finally {
    for (const run of runs) run.close();
  }
}
