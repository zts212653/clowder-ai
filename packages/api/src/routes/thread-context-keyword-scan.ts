import { performance } from 'node:perf_hooks';

export const KEYWORD_SCAN_MAX_MESSAGES = 2_000;
export const KEYWORD_SCAN_MIN_PAGE_SIZE = 500;
export const KEYWORD_SCAN_MAX_PAGE_SIZE = 1_000;

export interface RankedThreadContextMatch<T> {
  item: T;
  score: number;
}

export interface KeywordScanBatchTiming {
  loaded: number;
  scanned: number;
  storageRoundTrips: number;
  storeMs: number;
  scoringMs: number;
}

export interface KeywordScanTiming {
  pageSize: number;
  batchCount: number;
  scannedCount: number;
  matchedCount: number;
  storeMs: number;
  scoringMs: number;
  storageRoundTrips: number;
  scanCapped: boolean;
  batches: KeywordScanBatchTiming[];
}

export interface RankedThreadContextScanResult<T> {
  matches: RankedThreadContextMatch<T>[];
  scanCapped: boolean;
  timing: KeywordScanTiming;
}

interface RankedThreadContextScanOptions<T> {
  requestedLimit: number;
  fetchBatch: (
    limit: number,
    scanLimit: number,
  ) => Promise<{
    items: readonly T[];
    scannedCount: number;
    storageRoundTrips: number;
    exhausted: boolean;
  }>;
  canInclude: (item: T) => boolean;
  score: (item: T) => number;
  getTimestamp: (item: T) => number;
}

function keywordScanPageSize(requestedLimit: number): number {
  return Math.min(Math.max(requestedLimit * 5, KEYWORD_SCAN_MIN_PAGE_SIZE), KEYWORD_SCAN_MAX_PAGE_SIZE);
}

export async function scanRankedThreadContext<T>(
  options: RankedThreadContextScanOptions<T>,
): Promise<RankedThreadContextScanResult<T>> {
  const pageSize = keywordScanPageSize(options.requestedLimit);
  const matches: RankedThreadContextMatch<T>[] = [];
  const batches: KeywordScanBatchTiming[] = [];
  let scannedCount = 0;
  let storeMs = 0;
  let scoringMs = 0;
  let storageRoundTrips = 0;
  let exhausted = false;

  while (!exhausted && scannedCount < KEYWORD_SCAN_MAX_MESSAGES) {
    const remainingScan = KEYWORD_SCAN_MAX_MESSAGES - scannedCount;
    const storeStarted = performance.now();
    const fetched = await options.fetchBatch(pageSize, remainingScan);
    const batchStoreMs = performance.now() - storeStarted;
    storeMs += batchStoreMs;
    storageRoundTrips += fetched.storageRoundTrips;

    if (fetched.scannedCount < 0 || fetched.scannedCount > remainingScan) {
      throw new Error(`keyword scan store exceeded raw scan budget: ${fetched.scannedCount}/${remainingScan}`);
    }
    const batch = fetched.items;
    scannedCount += fetched.scannedCount;
    const scoringStarted = performance.now();
    for (const item of batch) {
      if (!options.canInclude(item)) continue;
      const itemScore = options.score(item);
      if (itemScore > 0) matches.push({ item, score: itemScore });
    }
    const batchScoringMs = performance.now() - scoringStarted;
    scoringMs += batchScoringMs;
    batches.push({
      loaded: batch.length,
      scanned: fetched.scannedCount,
      storageRoundTrips: fetched.storageRoundTrips,
      storeMs: batchStoreMs,
      scoringMs: batchScoringMs,
    });

    exhausted = fetched.exhausted;
    if (!exhausted && fetched.scannedCount === 0) break;
  }

  matches.sort((a, b) => b.score - a.score || options.getTimestamp(b.item) - options.getTimestamp(a.item));
  const scanCapped = !exhausted;
  const selected = matches.slice(0, options.requestedLimit);

  return {
    matches: selected,
    scanCapped,
    timing: {
      pageSize,
      batchCount: batches.length,
      scannedCount,
      matchedCount: matches.length,
      storeMs,
      scoringMs,
      storageRoundTrips,
      scanCapped,
      batches,
    },
  };
}
