import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { KEYWORD_SCAN_MAX_MESSAGES, KEYWORD_SCAN_MIN_PAGE_SIZE, scanRankedThreadContext } = await import(
  '../dist/routes/thread-context-keyword-scan.js'
);

function message(id, timestamp, score = 0) {
  return { id, timestamp, score };
}

describe('scanRankedThreadContext', () => {
  test('caps rare-keyword scans at 2,000 messages and four small-limit page calls', async () => {
    let calls = 0;
    let nextId = 0;
    const result = await scanRankedThreadContext({
      requestedLimit: 10,
      fetchBatch: async (limit) => {
        calls += 1;
        return {
          items: Array.from({ length: limit }, () => message(String(nextId), nextId++)),
          scannedCount: limit,
          storageRoundTrips: 2,
          exhausted: false,
        };
      },
      canInclude: () => true,
      score: () => 0,
      getTimestamp: (item) => item.timestamp,
    });

    assert.equal(result.timing.pageSize, KEYWORD_SCAN_MIN_PAGE_SIZE);
    assert.equal(result.timing.scannedCount, KEYWORD_SCAN_MAX_MESSAGES);
    assert.equal(result.timing.batchCount, 4);
    assert.equal(result.timing.storageRoundTrips, 8);
    assert.equal(calls, 4);
    assert.equal(result.scanCapped, true);
    assert.deepEqual(result.matches, []);
  });

  test('reports complete when a short page proves history exhaustion', async () => {
    let calls = 0;
    const items = [message('partial', 2, 0.5), message('exact', 1, 1)];
    const result = await scanRankedThreadContext({
      requestedLimit: 10,
      fetchBatch: async () => {
        calls += 1;
        return { items, scannedCount: items.length, storageRoundTrips: 0, exhausted: true };
      },
      canInclude: () => true,
      score: (item) => item.score,
      getTimestamp: (item) => item.timestamp,
    });

    assert.equal(calls, 1);
    assert.equal(result.scanCapped, false);
    assert.deepEqual(
      result.matches.map(({ item, score }) => [item.id, score]),
      [
        ['exact', 1],
        ['partial', 0.5],
      ],
    );
  });

  test('counts and times the empty terminal fetch after an exactly full page', async () => {
    let calls = 0;
    const fullPage = Array.from({ length: KEYWORD_SCAN_MIN_PAGE_SIZE }, (_, index) => message(String(index), index));
    const result = await scanRankedThreadContext({
      requestedLimit: 10,
      fetchBatch: async () => {
        calls += 1;
        return calls === 1
          ? { items: fullPage, scannedCount: fullPage.length, storageRoundTrips: 0, exhausted: false }
          : { items: [], scannedCount: 0, storageRoundTrips: 0, exhausted: true };
      },
      canInclude: () => true,
      score: () => 0,
      getTimestamp: (item) => item.timestamp,
    });

    assert.equal(calls, 2);
    assert.equal(result.timing.batchCount, 2);
    assert.equal(result.timing.batches.length, 2);
    assert.equal(result.timing.batches[1].loaded, 0);
    assert.equal(result.scanCapped, false);
  });

  test('keeps scanning the bounded window after partial matches fill the limit', async () => {
    let calls = 0;
    const firstPage = Array.from({ length: KEYWORD_SCAN_MIN_PAGE_SIZE }, (_, index) =>
      message(`recent-${index}`, index + 2, index < 2 ? 0.5 : 0),
    );
    const result = await scanRankedThreadContext({
      requestedLimit: 2,
      fetchBatch: async () => {
        calls += 1;
        return calls === 1
          ? { items: firstPage, scannedCount: firstPage.length, storageRoundTrips: 0, exhausted: false }
          : { items: [message('exact-at-501', 1, 1)], scannedCount: 1, storageRoundTrips: 0, exhausted: true };
      },
      canInclude: () => true,
      score: (item) => item.score,
      getTimestamp: (item) => item.timestamp,
    });

    assert.equal(calls, 2);
    assert.equal(result.scanCapped, false);
    assert.deepEqual(
      result.matches.map(({ item }) => item.id),
      ['exact-at-501', 'recent-1'],
    );
  });

  test('scores each included scanned item once and exposes timing breakdown', async () => {
    const scoreCalls = new Map();
    const items = [message('a', 1, 1), message('b', 2, 0.5), message('hidden', 3, 1)];
    const result = await scanRankedThreadContext({
      requestedLimit: 10,
      fetchBatch: async () => ({
        items,
        scannedCount: items.length,
        storageRoundTrips: 0,
        exhausted: true,
      }),
      canInclude: (item) => item.id !== 'hidden',
      score: (item) => {
        scoreCalls.set(item.id, (scoreCalls.get(item.id) ?? 0) + 1);
        return item.score;
      },
      getTimestamp: (item) => item.timestamp,
    });

    assert.deepEqual(Object.fromEntries(scoreCalls), { a: 1, b: 1 });
    assert.equal(result.timing.batchCount, 1);
    assert.equal(result.timing.batches.length, 1);
    assert.equal(result.timing.batches[0].loaded, 3);
    assert.equal(result.timing.batches[0].scanned, 3);
    assert.ok(result.timing.storeMs >= 0);
    assert.ok(result.timing.scoringMs >= 0);
  });
});
