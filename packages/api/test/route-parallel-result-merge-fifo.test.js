/**
 * F200 HW-4 根因① — route-parallel per-cat pending FIFO for result-merge.
 *
 * Audit Round 1 (砚砚): Claude/Opus parallel tool_result often carries no
 * result-side toolName / toolUseId / mcp: label. route-parallel.ts:693
 * `if (toolNameCandidate)` then skips deriveResultSummary+updateSummary
 * entirely → _f200Candidates/resultCount never merged → recall_events
 * candidates_json=[] (59.2% in audit). route-serial.ts:197-227 has a pure
 * FIFO fallback; parallel has none.
 *
 * Scenario A (core, AC-HW4-5): nameless tool_result must still merge via
 *   per-cat pending FIFO.
 * Scenario B (queue drift, 砚砚 review): an exact-match (toolName-bearing)
 *   result must SPLICE its name out of the FIFO, not just shift the head,
 *   else a later nameless result mis-pairs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, messages) {
  return {
    async *invoke() {
      for (const m of messages) {
        yield { ...m, catId, timestamp: Date.now() };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, toolEventLog) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    toolEventLog,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

const SEARCH_RESULT_TEXT = [
  'Found 5 result(s) for "harness eval":',
  '',
  '[high] F200 memory recall eval',
  '  anchor: F200',
  '  type: feature',
  '',
  '[mid] socio-technical harness',
  '  anchor: F192',
  '  type: feature',
].join('\n');

describe('F200 HW-4 根因①: route-parallel per-cat pending FIFO', () => {
  it('Scenario A: nameless tool_result still merges _f200Candidates via per-cat FIFO', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const updateSummaryCalls = [];
    const toolEventLog = {
      append: async () => {},
      updateSummary: async (threadId, matcher, summary) => {
        updateSummaryCalls.push({ threadId, matcher, summary });
      },
    };
    const services = {
      opus: createMockService('opus', [
        { type: 'tool_use', toolName: 'search_evidence', toolInput: { query: 'harness eval' }, toolUseId: 'tu-A1' },
        // result-side carries NO toolName / toolUseId / mcp label (Claude/Opus parallel reality)
        { type: 'tool_result', content: SEARCH_RESULT_TEXT },
      ]),
    };
    const deps = createMockDeps(services, toolEventLog);

    for await (const _m of routeParallel(deps, ['opus'], 'hello', 'user1', 'thread1', {})) {
      // drain
    }

    assert.equal(
      updateSummaryCalls.length,
      1,
      'updateSummary must be called once for the nameless search_evidence result (FIFO-resolved)',
    );
    const { summary } = updateSummaryCalls[0];
    assert.equal(summary.resultCount, 5, 'resultCount parsed from result text');
    assert.ok(
      Array.isArray(summary._f200Candidates) && summary._f200Candidates.length >= 1,
      '_f200Candidates extracted',
    );
    assert.equal(summary._f200Candidates[0].anchor, 'F200', 'first candidate anchor = F200');
  });

  it('Scenario B: exact-match result splices its name out of FIFO, nameless follower pairs the right tool', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const updateSummaryCalls = [];
    const toolEventLog = {
      append: async () => {},
      updateSummary: async (threadId, matcher, summary) => {
        updateSummaryCalls.push({ threadId, matcher, summary });
      },
    };
    const GRAPH_RESULT_TEXT = 'Graph for "F167": 3 nodes, 2 edges (depth=1)\nF167 -[related_to]-> F200';
    const services = {
      opus: createMockService('opus', [
        { type: 'tool_use', toolName: 'search_evidence', toolInput: { query: 'q1' }, toolUseId: 'tu-B1' },
        { type: 'tool_use', toolName: 'graph_resolve', toolInput: { query: 'F167' }, toolUseId: 'tu-B2' },
        // exact-match result FIRST (carries toolName) — must remove graph_resolve from FIFO
        { type: 'tool_result', toolName: 'graph_resolve', content: GRAPH_RESULT_TEXT },
        // nameless result SECOND — must pair to the remaining FIFO entry (search_evidence), NOT graph_resolve
        { type: 'tool_result', content: SEARCH_RESULT_TEXT },
      ]),
    };
    const deps = createMockDeps(services, toolEventLog);

    for await (const _m of routeParallel(deps, ['opus'], 'hello', 'user1', 'thread1', {})) {
      // drain
    }

    assert.equal(updateSummaryCalls.length, 2, 'both results merge (graph_resolve exact + search_evidence FIFO)');
    const searchCall = updateSummaryCalls.find(
      (c) => c.summary._f200Candidates?.[0]?.anchor === 'F200' && c.summary.resultCount === 5,
    );
    assert.ok(
      searchCall,
      'the nameless result must be paired to search_evidence (resultCount=5 / anchor F200), not mis-attributed to graph_resolve',
    );
  });

  it('Scenario C: same-name repeat — exact result splices by toolUseId, not first same-name (砚砚 R1-2)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const updateSummaryCalls = [];
    const toolEventLog = {
      append: async () => {},
      updateSummary: async (threadId, matcher, summary) => {
        updateSummaryCalls.push({ threadId, matcher, summary });
      },
    };
    const SEARCH2 = ['Found 9 result(s) for "q3":', '', '[high] X feature', '  anchor: F9', '  type: feature'].join(
      '\n',
    );
    const services = {
      opus: createMockService('opus', [
        { type: 'tool_use', toolName: 'search_evidence', toolInput: { query: 'q1' }, toolUseId: 'tu-C1' },
        { type: 'tool_use', toolName: 'graph_resolve', toolInput: { query: 'F1' }, toolUseId: 'tu-C2' },
        { type: 'tool_use', toolName: 'search_evidence', toolInput: { query: 'q3' }, toolUseId: 'tu-C3' },
        // exact result for the THIRD tool_use (tu-C3) returns FIRST — must splice
        // the tu-C3 entry, NOT the first same-name (tu-C1).
        { type: 'tool_result', toolName: 'search_evidence', toolUseId: 'tu-C3', content: SEARCH_RESULT_TEXT },
        // nameless result — FIFO must give it tu-C1 search (resultCount 9),
        // not mis-pair to graph_resolve (tu-C2) which yields no summary.
        { type: 'tool_result', content: SEARCH2 },
      ]),
    };
    const deps = createMockDeps(services, toolEventLog);
    for await (const _m of routeParallel(deps, ['opus'], 'hi', 'user1', 'thread1', {})) {
      // drain
    }

    assert.equal(
      updateSummaryCalls.length,
      2,
      'both results merge (exact tu-C3 + nameless FIFO→tu-C1 search); bug splices tu-C1 then nameless mis-pairs to graph (no summary)',
    );
    const nameless = updateSummaryCalls.find((c) => c.summary.resultCount === 9);
    assert.ok(
      nameless,
      'nameless result must pair to search_evidence (resultCount=9), not graph_resolve (which would yield no summary)',
    );
  });
});
