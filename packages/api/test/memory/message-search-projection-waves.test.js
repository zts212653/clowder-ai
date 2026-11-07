import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { collectMessageSearchCandidates } from '../../dist/domains/memory/message-search-candidates.js';

test('relevance projection fits the same I/O budget without removing any canonical admission', async (t) => {
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let waves = 0;
  let scheduled = false;
  let pending = [];
  const reads = { messages: 0, threads: 0, currentPassages: 0, maximumInFlight: 0 };
  // All reads issued before the next I/O completion share one round trip.
  const read = (value) =>
    new Promise((resolve) => {
      pending.push(() => resolve(value));
      reads.maximumInFlight = Math.max(reads.maximumInFlight, pending.length);
      if (scheduled) return;
      scheduled = true;
      setImmediate(() => {
        const batch = pending;
        pending = [];
        scheduled = false;
        now += 100;
        waves++;
        for (const release of batch.reverse()) release(); // Completion order is deliberately reversed.
      });
    });
  const thread = { id: 'visible', createdBy: 'owner', title: 'Source' };
  const messages = Array.from({ length: 64 }, (_, i) => ({
    id: `m-${i}`,
    threadId: thread.id,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    timestamp: now + i,
    content: `Neutral package credential discussion ${i}`,
  }));
  const candidates = messages.map((m) => ({
    threadId: m.threadId,
    messageId: m.id,
    docAnchor: `thread-${m.threadId}`,
    passageId: `msg-${m.id}`,
    content: m.content,
    match: 'semantic',
  }));
  const calls = [];
  const service = new MessageSearchService({
    threadStore: {
      list: () => [thread],
      get: () => {
        reads.threads++;
        return read(thread);
      },
    },
    messageStore: {
      getById: (id) => {
        reads.messages++;
        return read(messages.find((m) => m.id === id));
      },
    },
    evidenceStore: {
      readMessagePassageState: () => {
        reads.currentPassages++;
        return { current: true };
      },
      searchMessagePassages: async () => ({
        passages: candidates,
        meta: { effectiveMode: 'hybrid', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: true },
      }),
    },
    qualifier: {
      qualify() {
        calls.push('forbidden');
        throw new Error('Qualification is retired');
      },
    },
  });
  // The same 5000ms permits 50 round trips; relevance admits limit+1 before final revalidation.
  const result = await service.search(
    { query: 'package login', sort: 'relevance', mode: 'hybrid', limit: 12 },
    { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } },
    { deadlineAt: now + 5000 },
  );
  assert.equal(result.meta.qualification, undefined);
  assert.equal(result.meta.sourceCoverage, 'unknown');
  assert.deepEqual(
    result.results.map((row) => row.messageId),
    Array.from({ length: 12 }, (_, i) => `m-${i}`),
  );
  assert.equal(calls.length, 0);
  assert.equal(reads.messages, 26, 'limit+1 admitted sources are re-read before returning');
  assert.equal(reads.threads, 26);
  assert.equal(reads.currentPassages, 26);
  assert.ok(reads.maximumInFlight > 1 && reads.maximumInFlight <= 8);
  assert.ok(waves <= 50, JSON.stringify({ waves, reads }));
  t.diagnostic(
    JSON.stringify({
      kind: 'deterministic I/O wave witness, not production latency',
      waves,
      reads,
      virtualElapsedMs: now - 1_700_000_000_000,
    }),
  );
});

test('overlapped reads retain the serial admitted prefix, canonical dates and exact witness budget', async () => {
  for (const sort of ['relevance', 'time'])
    for (const limit of [1, 3, 12, 20]) {
      const candidates = Array.from({ length: 70 }, (_, i) => {
        const threadId = i === 4 ? 'foreign' : 'visible';
        const messageId = i === 3 ? 'm-2' : `m-${i}`;
        return {
          threadId,
          messageId,
          docAnchor: `thread-${threadId}`,
          passageId: `msg-${messageId}`,
          content: i % 3 ? 'piano exact evidence' : 'semantic-only source',
          match: 'semantic',
        };
      });
      const canonicalTime = (c) => Date.UTC(2026, 9, c.messageId === 'm-0' ? 8 : 9) + Number(c.messageId.slice(2));
      const search = { query: 'piano', sort, limit, dateFrom: '2026-10-09', dateTo: '2026-10-09' };
      // Independent admitted-prefix oracle: invalid sources never qualify and
      // indexed timestamps are not used. All asynchronous completions are reversed.
      const expected = admittedIds(candidates, sort, limit, canonicalTime);
      const pending = [];
      let scheduled = false;
      const rows = await collectMessageSearchCandidates({
        search,
        candidates,
        threadIds: new Set(['visible']),
        check: () => {},
        project: (c) =>
          new Promise((resolve) => {
            pending.push(() =>
              resolve(c.messageId === 'm-7' ? null : { ...c, result: { timestamp: canonicalTime(c) } }),
            );
            if (!scheduled) {
              scheduled = true;
              setImmediate(() => {
                const releases = pending.splice(0);
                scheduled = false;
                for (const done of releases.reverse()) done();
              });
            }
          }),
      });
      assert.deepEqual(
        rows.map((r) => r.messageId),
        expected,
        `${sort}/${limit}`,
      );
    }
});

function admittedIds(candidates, sort, limit, canonicalTime) {
  const unique = new Set();
  const expected = [];
  for (const c of candidates) {
    if (c.threadId !== 'visible' || c.messageId === 'm-7' || unique.has(c.messageId)) continue;
    unique.add(c.messageId);
    if (canonicalTime(c) < Date.UTC(2026, 9, 9)) continue;
    expected.push(c.messageId);
    if (expected.length === (sort === 'relevance' ? limit + 1 : 32)) break;
  }
  if (sort === 'time') expected.sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  return expected;
}
