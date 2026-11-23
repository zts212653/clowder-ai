import type { MatterCatalog, MatterCatalogItem, MatterUnavailableItem } from '@cat-cafe/shared';
import { getCallbackConfig } from './callback-tools.js';
import { handleListMemoryMatters } from './matter-memory-tools.js';
import { cappedLimit, type FindContext } from './memory-find-context.js';
import {
  type Candidate,
  ERROR_TEXT_CAP,
  type FindGroup,
  type GroupOutcome,
  type GroupPlan,
} from './memory-find-group.js';
import { canReadMemoryKind } from './memory-read-access.js';

/**
 * F332 find unification — the matters group of cat_cafe_search_evidence.
 * It forwards the caller's whole query to the original owner-scoped directory callback
 * (MatterMemoryService.catalog); visibility, ordering, cursor and revisions stay with that owner.
 */

/** The original directory route trims and accepts at most 200 characters; longer text is never cut. */
export const MATTER_QUERY_MAX_CHARS = 200;
export const MATTER_LIMIT_WITH_OTHER_GROUPS = 5;
/** The original directory default page size, used when matters is not beside the docs page. */
export const MATTER_LIMIT_ALONE = 12;
/** F1 continuation token for the first page; kept so earlier next.arguments still open the page. */
export const MATTER_FIRST_PAGE = 'first';
const DESCRIPTION_ITEM_CAP = 1_200;
const EXCERPT_RADIUS = 60;

const MATCH_RULE = 'whole query, literal case-insensitive substring of title or description; not split or semantic';
const ORDER_RULE = 'pages with active unchanged sources from this thread first, then updatedAt, then matterId';
const SCOPE_RULE = 'active matter pages whose sources this invocation can currently read';

export interface MatterRun {
  query?: string;
  cursor?: string;
  limit: number;
  limitNote?: string;
}

/** Whether this identity originally had the matter directory (full runtime or watcher, with callback identity). */
export function matterGroupQualified(): boolean {
  return canReadMemoryKind('matter') && getCallbackConfig() !== null;
}

/** Explicit ranges this directory is outside of skip it; global narrowing it cannot keep marks it not_covered. */
export function planMatters(context: FindContext): GroupPlan<MatterRun> {
  if (!matterGroupQualified()) return { kind: 'skip' };
  if (context.mode === 'continue' && context.continueGroup !== 'matters' && !context.matterCursor)
    return { kind: 'skip' };
  if (context.scope && !['all', 'memory'].includes(context.scope)) return { kind: 'skip' };
  // Matter pages are a project directory, not a registered collection: every other explicit dimension is outside.
  if (context.dimension && context.dimension !== 'project') return { kind: 'skip' };
  if (context.kinds?.length) return { kind: 'skip' };
  if (context.threadId)
    return {
      kind: 'not_covered',
      reason: 'thread_filter_unsupported',
      detail: 'The matter directory cannot restrict pages to one thread; no wider page list was returned.',
    };
  if (context.dateFrom || context.dateTo || context.since)
    return {
      kind: 'not_covered',
      reason: 'time_filter_unsupported',
      detail: 'The matter directory has no date filter; no undated page list was returned.',
    };
  const query = context.query?.trim() || undefined;
  if (query && query.length > MATTER_QUERY_MAX_CHARS)
    return {
      kind: 'not_covered',
      reason: 'query_longer_than_200_characters',
      detail: `The directory matches the whole query up to ${MATTER_QUERY_MAX_CHARS} characters; it was not truncated or split.`,
    };
  const capped = cappedLimit('matters', context.limit);
  // Beside the docs page the directory shows a short page; alone (browse, continuation, watcher) its original size.
  const besideDocs = context.mode === 'query' && !context.watcher;
  const limit = capped.limit ?? (besideDocs ? MATTER_LIMIT_WITH_OTHER_GROUPS : MATTER_LIMIT_ALONE);
  const cursor = context.matterCursor && context.matterCursor !== MATTER_FIRST_PAGE ? context.matterCursor : undefined;
  return {
    kind: 'run',
    run: {
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
      limit,
      ...(capped.note ? { limitNote: capped.note } : {}),
    },
  };
}

async function fetchMatters(run: MatterRun, signal: AbortSignal): Promise<GroupOutcome<MatterCatalog>> {
  const result = await handleListMemoryMatters(
    { ...(run.query ? { query: run.query } : {}), ...(run.cursor ? { cursor: run.cursor } : {}), limit: run.limit },
    { signal },
  );
  if (signal.aborted) return { status: 'timeout' };
  const text = result.content.map((block) => block.text ?? '').join('\n');
  if (result.isError) return { status: 'failed', error: text.slice(0, ERROR_TEXT_CAP) };
  const catalog = JSON.parse(text) as MatterCatalog;
  if (!Array.isArray(catalog.items)) return { status: 'failed', error: 'matter directory returned no items array' };
  return { status: catalog.items.length > 0 ? 'ok' : 'no_results', data: catalog };
}

export function createMattersGroup(context: FindContext): FindGroup<MatterCatalog> {
  const plan = planMatters(context);
  const run = plan.kind === 'run' ? plan.run : undefined;
  return {
    name: 'matters',
    plan,
    start: (signal) => (run ? fetchMatters(run, signal) : Promise.resolve({ status: 'timeout' })),
    counts: (catalog) => ({ count: catalog.items.length, hasNext: Boolean(catalog.nextCursor) }),
    emptyDetail: () => ({ match: run?.query ? MATCH_RULE : 'none (browse without query)', complete: true }),
    // Reopen the page this run asked for: a later page keeps its own cursor. The first page reopens with
    // continueGroup, or for the watcher (whose find contract accepts only query/matterCursor/limit) the F1 form.
    continueArguments: () => ({
      ...(run?.query ? { query: run.query } : {}),
      ...(run?.cursor
        ? { matterCursor: run.cursor }
        : context.watcher
          ? { matterCursor: MATTER_FIRST_PAGE }
          : { continueGroup: 'matters' }),
      limit: run?.limit ?? MATTER_LIMIT_ALONE,
    }),
    pages: (outcome, options) => {
      if (!run) return [];
      const next = outcome.data.nextCursor ? nextCall(run, outcome.data.nextCursor) : undefined;
      return PROJECTIONS.map(
        (projection): Candidate => ({
          status: outcome.status,
          text: pageText(run, outcome.status, outcome.data, next, projection, {
            budgetChars: options.budgetChars,
            withDescriptions: options.alone,
          }),
        }),
      );
    },
  };
}

function nextCall(run: MatterRun, cursor: string) {
  return {
    tool: 'cat_cafe_search_evidence',
    arguments: { ...(run.query ? { query: run.query } : {}), matterCursor: cursor, limit: run.limit },
  };
}

type FindMatterItem = Record<string, unknown>;

function safeSlice(text: string, start: number, end: number): string {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && /[\uDC00-\uDFFF]/.test(text[from] ?? '')) from--;
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to] ?? '')) to++;
  return text.slice(from, to);
}

/** The basis the original matcher used: where the whole query occurs. Not a relevance judgement. */
function matchBasis(item: MatterCatalogItem, query: string | undefined): FindMatterItem {
  if (!query) return {};
  const needle = query.toLocaleLowerCase();
  const { title, description } = item;
  if (title.toLocaleLowerCase().includes(needle)) return { matchedIn: 'title' };
  const lowered = description.toLocaleLowerCase();
  const at = lowered.indexOf(needle);
  if (at < 0 || lowered.length !== description.length) return { matchedIn: 'title_or_description' };
  const start = at - EXCERPT_RADIUS;
  const end = at + query.length + EXCERPT_RADIUS;
  const excerpt = safeSlice(description, start, end);
  return {
    matchedIn: 'description',
    matchExcerpt: `${start > 0 ? '…' : ''}${excerpt}${end < description.length ? '…' : ''}`,
  };
}

function isUnavailable(item: MatterCatalogItem | MatterUnavailableItem): item is MatterUnavailableItem {
  return 'unavailable' in item && item.unavailable === true;
}

type Projection = 'full' | 'compact' | 'minimal';
const PROJECTIONS: readonly Projection[] = ['full', 'compact', 'minimal'];

/**
 * full keeps the directory's original item fields (minus the description) plus the match basis; compact drops
 * timestamps and the excerpt; minimal keeps the title, the match location and the read coordinate. Items are never
 * dropped from a page, so the original cursor stays exact.
 */
function projectItem(
  item: MatterCatalogItem | MatterUnavailableItem,
  query: string | undefined,
  projection: Projection,
): FindMatterItem {
  if (isUnavailable(item)) return { matterId: item.matterId, revision: item.revision, unavailable: true };
  const basis = matchBasis(item, query);
  const readRef = item.readRef ?? { kind: 'matter', matterId: item.matterId, expectedRevision: item.revision };
  if (projection === 'full') {
    const { description: _description, ...original } = item;
    return { ...original, ...basis };
  }
  const location = basis.matchedIn ? { matchedIn: basis.matchedIn } : {};
  const changed = item.summaryStatus ? { summaryStatus: item.summaryStatus } : {};
  if (projection === 'minimal') return { title: item.title, ...location, ...changed, readRef };
  return {
    matterId: item.matterId,
    title: item.title,
    revision: item.revision,
    entryCount: item.entryCount,
    ...(item.status !== 'active' ? { status: item.status } : {}),
    ...(item.hasThreadSource !== undefined ? { hasThreadSource: item.hasThreadSource } : {}),
    ...changed,
    ...location,
    readRef,
  };
}

function pageText(
  run: MatterRun,
  status: string,
  catalog: MatterCatalog,
  next: ReturnType<typeof nextCall> | undefined,
  projection: Projection,
  options: { budgetChars: number; withDescriptions: boolean },
): string {
  const items = catalog.items.map((item) => projectItem(item, run.query, projection));
  const envelope = (rendered: FindMatterItem[]) =>
    JSON.stringify(matterEnvelope(run, status, projection, rendered, next, options.withDescriptions));
  const text = envelope(items);
  if (!options.withDescriptions || projection !== 'full' || text.length > options.budgetChars) return text;
  return addWholeDescriptions(catalog, items, envelope, options.budgetChars) ?? text;
}

function matchRule(run: MatterRun): string {
  return run.query ? MATCH_RULE : 'none (browse without query)';
}

function matterEnvelope(
  run: MatterRun,
  status: string,
  projection: Projection,
  items: FindMatterItem[],
  next: ReturnType<typeof nextCall> | undefined,
  withDescriptions: boolean,
) {
  const tail = { items, ...(next ? { next } : { complete: true }) };
  if (projection !== 'full')
    return {
      group: 'matters',
      status,
      projection,
      match: matchRule(run),
      ...(run.limitNote ? { limitNote: run.limitNote } : {}),
      ...tail,
      note: 'Bounded projection; open readRef with cat_cafe_read_memory. Listing records no read.',
    };
  return {
    group: 'matters',
    status,
    match: matchRule(run),
    scope: SCOPE_RULE,
    order: ORDER_RULE,
    ...(run.query ? { query: run.query } : {}),
    ...(run.limitNote ? { limitNote: run.limitNote } : {}),
    ...(withDescriptions
      ? {}
      : { descriptions: 'omitted beside other groups; matchExcerpt shows the matched text, readRef opens the page' }),
    ...tail,
    note: 'Listing does not record a read. Open readRef with cat_cafe_read_memory; descriptions are cat-written context, not original speech.',
  };
}

/** Whole descriptions are added while the envelope still fits; one that does not fit is omitted whole, never cut. */
function addWholeDescriptions(
  catalog: MatterCatalog,
  items: FindMatterItem[],
  envelope: (rendered: FindMatterItem[]) => string,
  budgetChars: number,
): string | undefined {
  const rendered = items.map((item) => ({ ...item }));
  let text: string | undefined;
  catalog.items.forEach((original, index) => {
    const target = rendered[index];
    if (!target || isUnavailable(original) || !original.description) return;
    const withDescription = { ...target, description: original.description };
    const candidate = envelope(rendered.map((row, i) => (i === index ? withDescription : row)));
    if (original.description.length <= DESCRIPTION_ITEM_CAP && candidate.length <= budgetChars) {
      rendered[index] = withDescription;
      text = candidate;
      return;
    }
    const omitted = { ...target, descriptionOmitted: { chars: original.description.length } };
    const marked = envelope(rendered.map((row, i) => (i === index ? omitted : row)));
    if (marked.length <= budgetChars) {
      rendered[index] = omitted;
      text = marked;
    }
  });
  return text;
}
