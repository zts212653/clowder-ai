/**
 * ToolEventLog + SkillLoadEventLog Tests — F188 Phase F (AC-F10)
 *
 * Verifies append-only sequence preservation (no dedup, FM-1/2/5 calculable)
 * and the derived nudge-followup analysis (FM-5 with grep fallback confound
 *排除 per 4.6 review #4).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** Minimal fake Redis with sorted-set ops used by the event log. */
function createFakeRedis() {
  /** key → array of [score, member] sorted ascending by score */
  const store = new Map();

  function getList(key) {
    if (!store.has(key)) store.set(key, []);
    return store.get(key);
  }

  return {
    _store: store,

    async zadd(key, score, member) {
      const list = getList(key);
      const before = list.length;
      // Reject exact duplicate member (matches Redis ZADD semantics)
      if (list.some((e) => e[1] === member)) return 0;
      list.push([score, member]);
      list.sort((a, b) => a[0] - b[0]);
      return list.length - before;
    },

    async zrange(key, start, stop, withScores) {
      const list = getList(key);
      const end = stop === -1 ? list.length : stop + 1;
      const slice = list.slice(start, end);
      if (withScores === 'WITHSCORES') {
        return slice.flatMap(([s, m]) => [m, String(s)]);
      }
      return slice.map(([, m]) => m);
    },

    async zrem(key, member) {
      const list = getList(key);
      const idx = list.findIndex((e) => e[1] === member);
      if (idx >= 0) {
        list.splice(idx, 1);
        return 1;
      }
      return 0;
    },

    /** SCAN cursor iteration: returns [nextCursor, batch]. Cursor='0' = done. */
    async scan(cursor, ...args) {
      const matchIdx = args.indexOf('MATCH');
      const countIdx = args.indexOf('COUNT');
      const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
      const count = countIdx >= 0 ? Number(args[countIdx + 1]) : 10;
      const re = new RegExp('^' + String(pattern).replace(/\*/g, '.*') + '$');
      const allKeys = [...store.keys()].filter((k) => re.test(k));
      const start = Number(cursor) || 0;
      const end = Math.min(start + count, allKeys.length);
      const nextCursor = end >= allKeys.length ? '0' : String(end);
      return [nextCursor, allKeys.slice(start, end)];
    },

    async expire(_key, _seconds) {
      // no-op for tests
    },
  };
}

function makeBaseEvent(overrides) {
  return {
    invocationId: 'inv-1',
    sessionId: 'sess-1',
    threadId: 'thread-A',
    catId: 'opus-47',
    toolName: 'search_evidence',
    timestamp: Date.now(),
    turnIndex: 0,
    status: 'success',
    summary: { resultCount: 5, topScore: 0.8, nudgeEmitted: false },
    ...overrides,
  };
}

describe('ToolEventLog (AC-F10)', () => {
  let fakeRedis;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
  });

  test('append + readByThread preserves order (no dedup)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Append 3 search_evidence events with same toolName — must NOT dedup
    await eventLog.append(makeBaseEvent({ timestamp: 100, turnIndex: 0 }));
    await eventLog.append(makeBaseEvent({ timestamp: 200, turnIndex: 1 }));
    await eventLog.append(makeBaseEvent({ timestamp: 300, turnIndex: 2 }));

    const events = await eventLog.readByThread('thread-A');
    assert.equal(events.length, 3, 'must preserve all 3 events, no dedup');
    assert.deepEqual(
      events.map((e) => e.turnIndex),
      [0, 1, 2],
      'must preserve order by timestamp',
    );
  });

  test('getAllSequencesAfterTool finds subsequences after every occurrence', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Pattern: search → Bash → search → Read
    await eventLog.append(makeBaseEvent({ toolName: 'search_evidence', timestamp: 100, turnIndex: 0 }));
    await eventLog.append(
      makeBaseEvent({ toolName: 'Bash', timestamp: 200, turnIndex: 1, summary: { command: 'grep foo' } }),
    );
    await eventLog.append(makeBaseEvent({ toolName: 'search_evidence', timestamp: 300, turnIndex: 2 }));
    await eventLog.append(makeBaseEvent({ toolName: 'Read', timestamp: 400, turnIndex: 3, summary: {} }));

    const sequences = await eventLog.getAllSequencesAfterTool('thread-A', 'search_evidence', 2);
    assert.equal(sequences.length, 2, 'two search_evidence occurrences → two sequences');
    assert.equal(sequences[0][0].toolName, 'Bash');
    assert.equal(sequences[1][0].toolName, 'Read');
  });

  test('analyzeNudgeFollowup detects nudgeFollowed when graph_resolve appears within lookahead', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // search with nudge → graph_resolve in next turn = followed=true
    await eventLog.append(
      makeBaseEvent({
        toolName: 'search_evidence',
        timestamp: 100,
        turnIndex: 0,
        summary: { resultCount: 0, topScore: null, nudgeEmitted: true },
        status: 'no_match',
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 200,
        turnIndex: 1,
        summary: { candidateCount: 1, rankedCandidateAnchors: ['F186'] },
      }),
    );

    const analysis = await eventLog.analyzeNudgeFollowup('thread-A', 3);
    assert.equal(analysis.length, 1);
    assert.equal(analysis[0].followed, true);
    assert.equal(analysis[0].followupTool, 'graph_resolve');
    assert.equal(analysis[0].fallbackGrepDetected, false);
  });

  test('analyzeNudgeFollowup detects fallbackGrepDetected — FM-5 confound 排除 (4.6 review #4)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // search with nudge → no graph/recent → Bash grep = followed=false AND fallback=true
    await eventLog.append(
      makeBaseEvent({
        toolName: 'search_evidence',
        timestamp: 100,
        turnIndex: 0,
        summary: { resultCount: 0, topScore: null, nudgeEmitted: true },
        status: 'no_match',
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        toolName: 'Bash',
        timestamp: 200,
        turnIndex: 1,
        summary: { command: 'grep -r "foo" packages/' },
      }),
    );

    const analysis = await eventLog.analyzeNudgeFollowup('thread-A', 3);
    assert.equal(analysis.length, 1);
    assert.equal(analysis[0].followed, false);
    assert.equal(analysis[0].fallbackGrepDetected, true, 'grep in next turn = nudge truly failed');
  });

  test('analyzeNudgeFollowup ignores search events without nudgeEmitted', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // search WITHOUT nudge — not in analysis
    await eventLog.append(
      makeBaseEvent({
        toolName: 'search_evidence',
        timestamp: 100,
        turnIndex: 0,
        summary: { resultCount: 5, topScore: 0.9, nudgeEmitted: false },
      }),
    );

    const analysis = await eventLog.analyzeNudgeFollowup('thread-A', 3);
    assert.equal(analysis.length, 0);
  });

  test('graph_resolve event with rankedCandidateAnchors lets selectedCandidateIndex be reconstructed', async () => {
    // 砚砚 三审 P3: don't just record candidateCount — store ranked anchors
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 100,
        turnIndex: 0,
        summary: {
          candidateCount: 3,
          rankedCandidateAnchors: ['F186', 'F188', 'F102'],
          selectedCandidateIndex: 1,
          selectedAnchor: 'F188',
        },
      }),
    );

    const events = await eventLog.readByThread('thread-A');
    assert.equal(events.length, 1);
    const summary = events[0].summary;
    assert.equal(summary.rankedCandidateAnchors.length, 3);
    // Reconstruct selectedCandidateIndex from anchor position
    const reconstructed = summary.rankedCandidateAnchors.indexOf(summary.selectedAnchor);
    assert.equal(reconstructed, 1);
    assert.equal(reconstructed, summary.selectedCandidateIndex);
  });

  test('analyzeNudgeFollowup scopes lookahead by catId — parallel-cat pollution guard (砚砚 cloud P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Cat A emits search_evidence with nudge — Cat B emits graph_resolve in next turn.
    // Without per-cat scope, B's graph_resolve would be misattributed as A's nudge followup.
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-A',
        toolName: 'search_evidence',
        timestamp: 100,
        turnIndex: 0,
        summary: { resultCount: 0, topScore: null, nudgeEmitted: true },
        status: 'no_match',
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-B', // different cat
        toolName: 'graph_resolve',
        timestamp: 200,
        turnIndex: 1,
        summary: { candidateCount: 1, rankedCandidateAnchors: ['F186'] },
      }),
    );

    const analysis = await eventLog.analyzeNudgeFollowup('thread-A', 3);
    assert.equal(analysis.length, 1);
    assert.equal(analysis[0].followed, false, "Cat B's graph_resolve must NOT count as Cat A's nudge followup");
  });

  test('updateSummary FIFO matches oldest unmerged event — parallel same-name calls (砚砚 cloud-3 P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Same cat issues two graph_resolve calls in parallel BEFORE either result returns.
    // r1 (resultCount=10) should merge into the FIRST call; r2 (resultCount=20) into the SECOND.
    // Pre-fix (latest-wins): both results would have collapsed onto the second call.
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 100,
        turnIndex: 0,
        summary: { query: 'F1' },
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 200,
        turnIndex: 1,
        summary: { query: 'F2' },
      }),
    );

    await eventLog.updateSummary('thread-A', { toolName: 'graph_resolve', catId: 'opus-47' }, { resultCount: 10 });
    await eventLog.updateSummary('thread-A', { toolName: 'graph_resolve', catId: 'opus-47' }, { resultCount: 20 });

    const events = await eventLog.readByThread('thread-A');
    assert.equal(events.length, 2);
    // FIFO: first call (query=F1) gets resultCount=10, second call (query=F2) gets resultCount=20.
    const call1 = events.find((e) => e.summary?.query === 'F1');
    const call2 = events.find((e) => e.summary?.query === 'F2');
    assert.equal(call1.summary.resultCount, 10, 'first call merged with first result (FIFO)');
    assert.equal(call2.summary.resultCount, 20, 'second call merged with second result (FIFO)');
    assert.equal(call1.summary._resultMerged, true);
    assert.equal(call2.summary._resultMerged, true);
  });

  test('listThreadIds uses SCAN cursor iteration (砚砚 cloud-5 P1: not KEYS)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    // Track that scan was called and keys was NOT.
    let scanCalls = 0;
    let keysCalls = 0;
    const baseRedis = fakeRedis;
    const trackingRedis = {
      ...baseRedis,
      scan: async (cursor, ...args) => {
        scanCalls++;
        return baseRedis.scan(cursor, ...args);
      },
      keys: async (p) => {
        keysCalls++;
        return [...baseRedis._store.keys()].filter((k) => k.startsWith(p.replace('*', '')));
      },
    };
    const eventLog = new ToolEventLog(trackingRedis);

    await eventLog.append(makeBaseEvent({ threadId: 'tA', timestamp: 100 }));
    await eventLog.append(makeBaseEvent({ threadId: 'tB', timestamp: 200 }));
    await eventLog.append(makeBaseEvent({ threadId: 'tC', timestamp: 300 }));

    const ids = await eventLog.listThreadIds();
    assert.deepEqual(ids.sort(), ['tA', 'tB', 'tC']);
    assert.ok(scanCalls > 0, 'SCAN must be used when available (not blocking KEYS)');
    assert.equal(keysCalls, 0, 'KEYS must NOT be called when SCAN is available');
  });

  test('analyzeNudgeFollowup window counts SAME-CAT events, not raw-timeline (砚砚 cloud-8 P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Cat A search with nudge. Three Cat B events interleave, then Cat A graph_resolve.
    // Pre-fix (slice-then-filter): raw window of 3 = [B, B, B] → filter A → [] →
    // FALSE NEGATIVE (A's follow-up at A's next event missed).
    // Post-fix (filter-then-count): walk until 3 same-cat events → [A_graph] → found.
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-A',
        toolName: 'search_evidence',
        timestamp: 100,
        turnIndex: 0,
        summary: { resultCount: 0, topScore: null, nudgeEmitted: true },
        status: 'no_match',
      }),
    );
    for (let i = 0; i < 3; i++) {
      await eventLog.append(
        makeBaseEvent({
          catId: 'opus-B',
          toolName: 'Read',
          timestamp: 110 + i * 10,
          turnIndex: i + 1,
          summary: {},
        }),
      );
    }
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-A',
        toolName: 'graph_resolve',
        timestamp: 200,
        turnIndex: 4,
        summary: { candidateCount: 1, rankedCandidateAnchors: ['F186'] },
      }),
    );

    const analysis = await eventLog.analyzeNudgeFollowup('thread-A', 3);
    assert.equal(analysis.length, 1);
    assert.equal(
      analysis[0].followed,
      true,
      "A's graph_resolve at A's next event must be detected even with 3 B events interleaved",
    );
    assert.equal(analysis[0].followupTool, 'graph_resolve');
  });

  test('getAllSequencesAfterTool window counts SAME-CAT events (砚砚 cloud-8 P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Same shape as nudge test, but verifying FM-1 grep_after_search window.
    // A_search → 5 B events → A_bash_grep — pre-fix would miss the grep fallback.
    await eventLog.append(
      makeBaseEvent({ catId: 'opus-A', toolName: 'search_evidence', timestamp: 100, turnIndex: 0 }),
    );
    for (let i = 0; i < 5; i++) {
      await eventLog.append(
        makeBaseEvent({
          catId: 'opus-B',
          toolName: 'Read',
          timestamp: 110 + i * 10,
          turnIndex: i + 1,
          summary: {},
        }),
      );
    }
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-A',
        toolName: 'Bash',
        timestamp: 200,
        turnIndex: 6,
        summary: { command: 'grep -r foo packages/' },
      }),
    );

    const sequences = await eventLog.getAllSequencesAfterTool('thread-A', 'search_evidence', 3);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0].length, 1, "A's Bash must be in window when counting same-cat events");
    assert.equal(sequences[0][0].toolName, 'Bash');
  });

  test('updateSummary serializes concurrent calls per-thread — FIFO preserved (砚砚 cloud-7 P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Two graph_resolve calls appended; results arrive in parallel.
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 100,
        turnIndex: 0,
        summary: { query: 'F1' },
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 200,
        turnIndex: 1,
        summary: { query: 'F2' },
      }),
    );

    // Fire BOTH updateSummary calls without awaiting individually — they race.
    // Pre-fix (no serialization): both promises read the same zrange snapshot,
    // both pick "oldest unmerged" event (F1), second overwrites first; F2 never
    // gets its summary. With serialization: F1 merges first, F2 merges second.
    const p1 = eventLog.updateSummary('thread-A', { toolName: 'graph_resolve', catId: 'opus-47' }, { resultCount: 10 });
    const p2 = eventLog.updateSummary('thread-A', { toolName: 'graph_resolve', catId: 'opus-47' }, { resultCount: 20 });
    await Promise.all([p1, p2]);

    const events = await eventLog.readByThread('thread-A');
    assert.equal(events.length, 2);
    const call1 = events.find((e) => e.summary?.query === 'F1');
    const call2 = events.find((e) => e.summary?.query === 'F2');
    assert.equal(call1.summary.resultCount, 10, 'first call merged with first result (FIFO preserved under race)');
    assert.equal(call2.summary.resultCount, 20, 'second call merged with second result (no clobber)');
  });

  test('listThreadIds dedupes when SCAN returns duplicate keys (砚砚 cloud-6 P2)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    // Fake redis whose scan returns the same key on every call (Redis behavior
    // allows duplicates across cursor iterations).
    let scanCallCount = 0;
    const duplicatingRedis = {
      ...fakeRedis,
      scan: async (cursor) => {
        scanCallCount++;
        // Return the same single key twice, with cursor advancing then terminating.
        if (cursor === '0') return ['1', ['tool-event-log:tDup']];
        return ['0', ['tool-event-log:tDup']];
      },
    };
    const eventLog = new ToolEventLog(duplicatingRedis);
    const ids = await eventLog.listThreadIds();
    assert.equal(ids.length, 1, 'duplicate scan results must be deduplicated');
    assert.equal(ids[0], 'tDup');
    assert.ok(scanCallCount >= 2, 'must iterate through multiple SCAN cursor pages');
  });

  test('updateSummary rejects WITHSCORES-ignoring shim with non-numeric odd slots (砚砚 cloud-6 P2)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    // Fake redis that ignores WITHSCORES and returns only members (even count).
    // Members are JSON strings — odd-indexed slots are NOT numeric. Strict
    // detection must fall back to "no scores" path (preserves event by using
    // event.timestamp as score), not treat members as score pairs.
    const eventA = JSON.stringify({
      threadId: 'thread-A',
      catId: 'opus-47',
      toolName: 'graph_resolve',
      timestamp: 100,
      summary: { query: 'F1' },
      invocationId: 'i1',
      sessionId: 's1',
      turnIndex: 0,
      status: 'success',
    });
    const eventB = JSON.stringify({
      threadId: 'thread-A',
      catId: 'opus-47',
      toolName: 'graph_resolve',
      timestamp: 200,
      summary: { query: 'F2' },
      invocationId: 'i2',
      sessionId: 's1',
      turnIndex: 1,
      status: 'success',
    });
    const shimRedis = {
      _store: new Map([
        [
          'tool-event-log:thread-A',
          [
            [1, eventA],
            [2, eventB],
          ],
        ],
      ]),
      async zrange(_key, _start, _stop, _withScores) {
        // Ignore WITHSCORES — return members only. Even count of NON-numeric strings.
        return [eventA, eventB];
      },
      async zadd() {
        return 1;
      },
      async zrem() {
        return 1;
      },
    };
    const eventLog = new ToolEventLog(shimRedis);
    // Patch must apply without dropping events / misparsing as score pairs.
    const ok = await eventLog.updateSummary(
      'thread-A',
      { toolName: 'graph_resolve', catId: 'opus-47' },
      { resultCount: 7 },
    );
    assert.equal(ok, true, 'must successfully apply patch via no-scores fallback path');
  });

  test('listThreadIds falls back to keys() when scan() unavailable (test-fake path)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    // Redis without scan — like older test fakes / shims.
    const noScanRedis = {
      ...fakeRedis,
      keys: async (p) => [...fakeRedis._store.keys()].filter((k) => k.startsWith(p.replace('*', ''))),
    };
    delete noScanRedis.scan;
    const eventLog = new ToolEventLog(noScanRedis);

    await eventLog.append(makeBaseEvent({ threadId: 'tFallback', timestamp: 100 }));
    const ids = await eventLog.listThreadIds();
    assert.deepEqual(ids, ['tFallback']);
  });

  test('updateSummary is idempotent on replayed tool_result by toolUseId (砚砚 cloud-4 P2)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Append an event with stored _toolUseId. Apply same patch twice via toolUseId.
    // toolUseId matcher does NOT check _resultMerged (exact-match wins anywhere),
    // so a retried tool_result would re-enter the merge path. Pre-fix: zadd no-ops
    // because newMember bytes match existing member, then zrem deletes the only copy.
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 100,
        summary: { query: 'F1', _toolUseId: 'tu_call_X' },
      }),
    );

    await eventLog.updateSummary('thread-A', { toolUseId: 'tu_call_X' }, { resultCount: 7 });
    const afterFirst = await eventLog.readByThread('thread-A');
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0].summary.resultCount, 7);

    // Replay the exact same patch — must short-circuit, NOT delete the event.
    await eventLog.updateSummary('thread-A', { toolUseId: 'tu_call_X' }, { resultCount: 7 });
    const afterReplay = await eventLog.readByThread('thread-A');
    assert.equal(afterReplay.length, 1, 'event must survive idempotent retry — zrem must not delete it');
    assert.equal(afterReplay[0].summary.resultCount, 7);
    assert.equal(afterReplay[0].summary._toolUseId, 'tu_call_X');
  });

  test('updateSummary exact-match by toolUseId (forward-compat for providers emitting tool_use_id)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Two events with toolUseId stored in summary; provider-emitted tool_use_id.
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 100,
        summary: { query: 'F1', _toolUseId: 'tu_call_A' },
      }),
    );
    await eventLog.append(
      makeBaseEvent({
        toolName: 'graph_resolve',
        timestamp: 200,
        summary: { query: 'F2', _toolUseId: 'tu_call_B' },
      }),
    );

    // Out-of-order result delivery: B's result arrives first, then A's. With toolUseId
    // matcher, each result merges into its corresponding call regardless of arrival order.
    await eventLog.updateSummary('thread-A', { toolUseId: 'tu_call_B' }, { resultCount: 20 });
    await eventLog.updateSummary('thread-A', { toolUseId: 'tu_call_A' }, { resultCount: 10 });

    const events = await eventLog.readByThread('thread-A');
    const callA = events.find((e) => e.summary?._toolUseId === 'tu_call_A');
    const callB = events.find((e) => e.summary?._toolUseId === 'tu_call_B');
    assert.equal(callA.summary.resultCount, 10);
    assert.equal(callB.summary.resultCount, 20);
  });

  test('getAllSequencesAfterTool scopes lookahead by catId — FM-1 parallel-cat pollution guard', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const eventLog = new ToolEventLog(fakeRedis);

    // Cat A's search_evidence followed by Cat B's Bash grep — must NOT count as fallback.
    await eventLog.append(
      makeBaseEvent({ catId: 'opus-A', toolName: 'search_evidence', timestamp: 100, turnIndex: 0 }),
    );
    await eventLog.append(
      makeBaseEvent({
        catId: 'opus-B',
        toolName: 'Bash',
        timestamp: 200,
        turnIndex: 1,
        summary: { command: 'grep foo src/' },
      }),
    );

    const sequences = await eventLog.getAllSequencesAfterTool('thread-A', 'search_evidence', 3);
    assert.equal(sequences.length, 1);
    assert.equal(sequences[0].length, 0, "Cat B's Bash grep must be filtered out of Cat A's lookahead window");
  });
});

describe('SkillLoadEventLog (AC-F10 / AS-4)', () => {
  let fakeRedis;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
  });

  test('append + readBySession preserves all loads (no dedup)', async () => {
    const { SkillLoadEventLog } = await import('../dist/domains/cats/services/tool-usage/SkillLoadEventLog.js');
    const skillLog = new SkillLoadEventLog(fakeRedis);

    await skillLog.append({
      invocationId: 'inv-1',
      sessionId: 'sess-1',
      skillId: 'memory-navigation',
      loadTrigger: 'keyword_match',
      timestamp: 100,
    });
    await skillLog.append({
      invocationId: 'inv-2',
      sessionId: 'sess-1',
      skillId: 'memory-navigation',
      loadTrigger: 'mention_match',
      timestamp: 200,
    });

    const loads = await skillLog.readBySession('sess-1');
    assert.equal(loads.length, 2, 'must preserve both loads, no Skill tool_use dedup');
    assert.equal(loads[0].loadTrigger, 'keyword_match');
    assert.equal(loads[1].loadTrigger, 'mention_match');
  });

  test('countLoadsBySkill filters by skillId', async () => {
    const { SkillLoadEventLog } = await import('../dist/domains/cats/services/tool-usage/SkillLoadEventLog.js');
    const skillLog = new SkillLoadEventLog(fakeRedis);

    await skillLog.append({
      invocationId: 'inv-1',
      sessionId: 'sess-1',
      skillId: 'memory-navigation',
      loadTrigger: 'keyword_match',
      timestamp: 100,
    });
    await skillLog.append({
      invocationId: 'inv-2',
      sessionId: 'sess-1',
      skillId: 'tdd',
      loadTrigger: 'explicit_call',
      timestamp: 200,
    });

    assert.equal(await skillLog.countLoadsBySkill('sess-1', 'memory-navigation'), 1);
    assert.equal(await skillLog.countLoadsBySkill('sess-1', 'tdd'), 1);
    assert.equal(await skillLog.countLoadsBySkill('sess-1', 'unknown'), 0);
  });
});
