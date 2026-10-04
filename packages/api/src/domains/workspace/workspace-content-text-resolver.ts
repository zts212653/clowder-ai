import type {
  WorkspaceTextAnchorV1,
  WorkspaceTextQuoteBatchRequestV1,
  WorkspaceTextQuoteBatchResolutionV1,
  WorkspaceTextQuoteResolutionV1,
} from './workspace-content-source-contract.js';
import { validateWorkspaceQuote, workspaceTextDigest } from './workspace-content-source-utils.js';

/** Bounded candidate work prevents repeated one-character text from allocating an unbounded offset list. */
export const MAX_TEXT_QUOTE_CANDIDATES_PER_QUOTE = 4_096;
export const MAX_TEXT_QUOTE_CANDIDATES_PER_BATCH = 16_384;
/** A batch may scan one owner-sized text snapshot, but cannot multiply that work by every distinct quote. */
export const MAX_TEXT_QUOTE_SCAN_UNITS_PER_QUOTE = 64 * 1024 * 1024;
export const MAX_TEXT_QUOTE_SCAN_UNITS_PER_BATCH = 64 * 1024 * 1024;

interface ScanBudget {
  candidatesRemaining: number;
  scanUnitsRemaining: number;
}

interface MatchTracker {
  readonly expectedContextDigest?: string;
  matches: number;
  first?: WorkspaceTextAnchorV1;
  exhausted: boolean;
}

interface PartitionedBatch {
  readonly results: Map<string, WorkspaceTextQuoteBatchResolutionV1>;
  readonly groups: Map<string, WorkspaceTextQuoteBatchRequestV1[]>;
}

export function resolveWorkspaceTextQuote(input: {
  readonly text: string;
  readonly quote: string;
  readonly expectedContextDigest?: string;
  readonly candidateBudget?: number;
  readonly scanBudget?: number;
}): WorkspaceTextQuoteResolutionV1 {
  const quote = validateWorkspaceQuote(input.quote);
  const tracker: MatchTracker = { expectedContextDigest: input.expectedContextDigest, matches: 0, exhausted: false };
  scanQuote(
    input.text,
    quote,
    [tracker],
    budgetFor(
      input.candidateBudget ?? MAX_TEXT_QUOTE_CANDIDATES_PER_QUOTE,
      input.scanBudget ?? MAX_TEXT_QUOTE_SCAN_UNITS_PER_QUOTE,
    ),
  );
  return trackerResolution(tracker);
}

/** Resolve a batch without retaining candidate offsets or anchoring any result to a different source revision. */
export function resolveWorkspaceTextQuoteBatch(input: {
  readonly text: string;
  readonly sourceRevision: string;
  readonly anchors: readonly WorkspaceTextQuoteBatchRequestV1[];
  readonly candidateBudget?: number;
  readonly scanBudget?: number;
}): WorkspaceTextQuoteBatchResolutionV1[] {
  const { results, groups } = partitionBatch(input.anchors, input.sourceRevision);
  const budget = budgetFor(
    input.candidateBudget ?? MAX_TEXT_QUOTE_CANDIDATES_PER_BATCH,
    input.scanBudget ?? MAX_TEXT_QUOTE_SCAN_UNITS_PER_BATCH,
  );
  for (const [quote, anchors] of groups) {
    resolveBatchGroup(results, input.text, quote, anchors, budget);
  }
  return input.anchors.map(
    (anchor) => results.get(anchor.annotationId) ?? { annotationId: anchor.annotationId, status: 'orphaned' },
  );
}

function partitionBatch(
  anchors: readonly WorkspaceTextQuoteBatchRequestV1[],
  sourceRevision: string,
): PartitionedBatch {
  const results = new Map<string, WorkspaceTextQuoteBatchResolutionV1>();
  const groups = new Map<string, WorkspaceTextQuoteBatchRequestV1[]>();
  for (const anchor of anchors) {
    const quote = validateBatchQuote(anchor, results);
    if (!quote) continue;
    if (anchor.baseRevision === sourceRevision) {
      results.set(anchor.annotationId, { annotationId: anchor.annotationId, status: 'attached' });
      continue;
    }
    const group = groups.get(quote) ?? [];
    group.push(anchor);
    groups.set(quote, group);
  }
  return { results, groups };
}

function validateBatchQuote(
  anchor: WorkspaceTextQuoteBatchRequestV1,
  results: Map<string, WorkspaceTextQuoteBatchResolutionV1>,
): string | undefined {
  let quote: string;
  try {
    quote = validateWorkspaceQuote(anchor.quote);
  } catch {
    results.set(anchor.annotationId, { annotationId: anchor.annotationId, status: 'orphaned' });
    return undefined;
  }
  if (anchor.expectedQuoteDigest && anchor.expectedQuoteDigest !== workspaceTextDigest(quote)) {
    results.set(anchor.annotationId, { annotationId: anchor.annotationId, status: 'orphaned' });
    return undefined;
  }
  return quote;
}

function resolveBatchGroup(
  results: Map<string, WorkspaceTextQuoteBatchResolutionV1>,
  text: string,
  quote: string,
  anchors: readonly WorkspaceTextQuoteBatchRequestV1[],
  budget: ScanBudget,
): void {
  const trackers = trackersFor(anchors);
  scanQuote(text, quote, [...trackers.values()], budget);
  for (const anchor of anchors) {
    const tracker = trackers.get(anchor.expectedContextDigest);
    results.set(anchor.annotationId, {
      annotationId: anchor.annotationId,
      ...(tracker ? trackerResolution(tracker) : { status: 'orphaned' as const }),
    });
  }
}

function trackersFor(anchors: readonly WorkspaceTextQuoteBatchRequestV1[]): Map<string | undefined, MatchTracker> {
  const trackers = new Map<string | undefined, MatchTracker>();
  for (const anchor of anchors) {
    if (trackers.has(anchor.expectedContextDigest)) continue;
    trackers.set(anchor.expectedContextDigest, {
      expectedContextDigest: anchor.expectedContextDigest,
      matches: 0,
      exhausted: false,
    });
  }
  return trackers;
}

function scanQuote(text: string, quote: string, trackers: readonly MatchTracker[], budget: ScanBudget): void {
  const prefix = prefixTable(quote);
  let quoteOffset = 0;
  let candidates = 0;
  for (let offset = 0; offset < text.length; offset += 1) {
    if (!consumeScanUnit(trackers, budget)) return;
    quoteOffset = advanceQuoteOffset(quote, prefix, quoteOffset, text[offset] ?? '');
    if (quoteOffset !== quote.length) continue;
    if (!consumeCandidate(trackers, budget, candidates)) return;
    candidates += 1;
    recordCandidate(trackers, sourceAnchor(text, quote, offset - quote.length + 1));
    if (trackers.every((tracker) => tracker.matches >= 2)) return;
    // KMP retains the longest suffix, so overlapping raw-source matches stay distinct candidates.
    quoteOffset = prefix[quoteOffset - 1] ?? 0;
  }
}

function consumeScanUnit(trackers: readonly MatchTracker[], budget: ScanBudget): boolean {
  if (budget.scanUnitsRemaining > 0) {
    budget.scanUnitsRemaining -= 1;
    return true;
  }
  exhaust(trackers);
  return false;
}

function consumeCandidate(trackers: readonly MatchTracker[], budget: ScanBudget, candidates: number): boolean {
  if (budget.candidatesRemaining > 0 && candidates < MAX_TEXT_QUOTE_CANDIDATES_PER_QUOTE) {
    budget.candidatesRemaining -= 1;
    return true;
  }
  exhaust(trackers);
  return false;
}

function recordCandidate(trackers: readonly MatchTracker[], candidate: WorkspaceTextAnchorV1): void {
  for (const tracker of trackers) {
    if (tracker.matches >= 2) continue;
    if (tracker.expectedContextDigest && candidate.contextDigest !== tracker.expectedContextDigest) continue;
    tracker.matches += 1;
    if (tracker.matches === 1) tracker.first = candidate;
  }
}

function exhaust(trackers: readonly MatchTracker[]): void {
  for (const tracker of trackers) if (tracker.matches < 2) tracker.exhausted = true;
}

function advanceQuoteOffset(quote: string, prefix: readonly number[], quoteOffset: number, character: string): number {
  let next = quoteOffset;
  while (next > 0 && character !== quote[next]) next = prefix[next - 1] ?? 0;
  return character === quote[next] ? next + 1 : next;
}

function prefixTable(quote: string): number[] {
  const prefix = new Array<number>(quote.length).fill(0);
  let length = 0;
  for (let index = 1; index < quote.length; index += 1) {
    while (length > 0 && quote[index] !== quote[length]) length = prefix[length - 1] ?? 0;
    if (quote[index] === quote[length]) length += 1;
    prefix[index] = length;
  }
  return prefix;
}

function trackerResolution(tracker: MatchTracker): WorkspaceTextQuoteResolutionV1 {
  if (tracker.exhausted || tracker.matches >= 2) return { status: 'ambiguous' };
  return tracker.matches === 1 && tracker.first
    ? { status: 'attached', anchor: tracker.first }
    : { status: 'orphaned' };
}

/** The anchor of an already-located raw range: the same digests every stored text anchor carries. */
export function workspaceTextAnchorAt(text: string, start: number, end: number): WorkspaceTextAnchorV1 {
  return sourceAnchor(text, text.slice(start, end), start);
}

function sourceAnchor(text: string, quote: string, start: number): WorkspaceTextAnchorV1 {
  const end = start + quote.length;
  const before = text.slice(Math.max(0, start - 96), start);
  const after = text.slice(end, end + 96);
  return {
    start,
    end,
    quote,
    quoteDigest: workspaceTextDigest(quote),
    contextDigest: workspaceTextDigest(`${before}\u0000${quote}\u0000${after}`),
  };
}

function budgetFor(candidateBudget: number, scanBudget: number): ScanBudget {
  return {
    candidatesRemaining: normalizedBudget(candidateBudget),
    scanUnitsRemaining: normalizedBudget(scanBudget),
  };
}

function normalizedBudget(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
