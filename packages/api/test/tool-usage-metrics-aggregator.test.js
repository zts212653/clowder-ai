/**
 * ToolUsageMetricsAggregator Tests — F188 Phase F (AC-F9)
 *
 * Verifies metrics computation, N≥20 threshold guard, insufficient-data
 * flag, FM-1 / FM-2 / FM-3 / FM-5 calculations.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

function createFakeRedis() {
  const store = new Map();
  function getList(key) {
    if (!store.has(key)) store.set(key, []);
    return store.get(key);
  }
  return {
    async zadd(key, score, member) {
      const list = getList(key);
      if (list.some((e) => e[1] === member)) return 0;
      list.push([score, member]);
      list.sort((a, b) => a[0] - b[0]);
      return 1;
    },
    async zrange(key, start, stop) {
      const list = getList(key);
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end).map(([, m]) => m);
    },
    async expire() {},
  };
}

describe('ToolUsageMetricsAggregator (AC-F9)', () => {
  let redis;

  beforeEach(() => {
    redis = createFakeRedis();
  });

  test('N < threshold returns insufficient_data flag (no false alarms)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // Only 3 events total - well below N≥20 threshold
    await eventLog.append({
      invocationId: 'i1',
      sessionId: 's1',
      threadId: 'tA',
      catId: 'c1',
      toolName: 'search_evidence',
      timestamp: 100,
      turnIndex: 0,
      status: 'success',
      summary: { resultCount: 1, topScore: 0.9, nudgeEmitted: false },
    });

    const report = await computeFromThreads(eventLog, [{ threadId: 'tA' }]);
    assert.equal(report.distribution.searchEvidence.sufficient, false);
    assert.equal(report.distribution.searchEvidence.value, null);
    assert.equal(report.distribution.searchEvidence.sampleN, 1);
    assert.equal(report.distribution.searchEvidence.threshold, 20);
  });

  test('FM-1 grep_after_search_rate computed when sufficient samples', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 20 search events, half followed by grep in next-5
    for (let i = 0; i < 20; i++) {
      await eventLog.append({
        invocationId: `i${i}`,
        sessionId: 's1',
        threadId: `t${i}`,
        catId: 'c1',
        toolName: 'search_evidence',
        timestamp: i * 100,
        turnIndex: 0,
        status: 'success',
        summary: { resultCount: 1, topScore: 0.5, nudgeEmitted: false },
      });
      if (i < 10) {
        await eventLog.append({
          invocationId: `i${i}b`,
          sessionId: 's1',
          threadId: `t${i}`,
          catId: 'c1',
          toolName: 'Bash',
          timestamp: i * 100 + 50,
          turnIndex: 1,
          status: 'success',
          summary: { command: 'grep -r foo packages/' },
        });
      }
    }

    const threads = Array.from({ length: 20 }, (_, i) => ({ threadId: `t${i}` }));
    const report = await computeFromThreads(eventLog, threads);
    assert.equal(report.grepAfterSearchRate.sufficient, true);
    assert.equal(report.grepAfterSearchRate.value, 50.0);
    assert.equal(report.grepAfterSearchRate.sampleN, 20);
  });

  test('FM-2 candidate_selection_distribution: non-first index ratio', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 20 graph_resolve with candidate selections; 12 picked non-first → 60%
    for (let i = 0; i < 20; i++) {
      await eventLog.append({
        invocationId: `i${i}`,
        sessionId: 's1',
        threadId: `t${i}`,
        catId: 'c1',
        toolName: 'graph_resolve',
        timestamp: i * 100,
        turnIndex: 0,
        status: 'success',
        summary: {
          candidateCount: 3,
          rankedCandidateAnchors: ['F1', 'F2', 'F3'],
          selectedCandidateIndex: i < 12 ? 1 : 0,
          selectedAnchor: i < 12 ? 'F2' : 'F1',
        },
      });
    }

    const threads = Array.from({ length: 20 }, (_, i) => ({ threadId: `t${i}` }));
    const report = await computeFromThreads(eventLog, threads);
    assert.equal(report.candidateSelectionDistribution.sufficient, true);
    assert.equal(report.candidateSelectionDistribution.value, 60.0);
    assert.equal(report.candidateSelectionDistribution.sampleN, 20);
  });

  test('FM-3 list_recent_adoption_rate scoped to cold-start window (砚砚 cloud P1)', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 5 threads × (5 search + 1 list_recent) — list_recent at pos 6 is OUTSIDE
    // the cold-start window (first 5 memory-class calls per cat per thread).
    // Global ratio would say "list_recent = 1/6 ≈ 16.7%" but FM-3 must report 0%
    // because zero-prior cold-start entry never used list_recent.
    for (let t = 0; t < 5; t++) {
      for (let i = 0; i < 5; i++) {
        await eventLog.append({
          invocationId: `i${t}-${i}`,
          sessionId: `s${t}`,
          threadId: `tA${t}`,
          catId: 'c1',
          toolName: 'search_evidence',
          timestamp: t * 1000 + i,
          turnIndex: i,
          status: 'success',
          summary: { resultCount: 1, topScore: 0.5, nudgeEmitted: false },
        });
      }
      await eventLog.append({
        invocationId: `i${t}-late`,
        sessionId: `s${t}`,
        threadId: `tA${t}`,
        catId: 'c1',
        toolName: 'list_recent',
        timestamp: t * 1000 + 99,
        turnIndex: 5,
        status: 'success',
        summary: { resultCount: 3, scope: 'docs', since: '7d' },
      });
    }

    const threads = Array.from({ length: 5 }, (_, i) => ({ threadId: `tA${i}` }));
    const report = await computeFromThreads(eventLog, threads);
    // Cold-start denominator = 25 (5 threads × 5 first calls). Numerator = 0.
    assert.equal(report.listRecentAdoptionRate.sampleN, 25, 'denominator = cold-start memory calls');
    assert.equal(report.listRecentAdoptionRate.value, 0, 'list_recent outside cold-start window must not count');
    // distribution.listRecent (global) is a different metric — still counts the late list_recent.
    assert.equal(report.distribution.listRecent.sampleN, 30, 'global memory call denominator unchanged');
  });

  test('FM-3 counts list_recent when it appears in cold-start window', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 5 threads × 5 calls (list_recent first, then 4 search) — all within cold-start.
    for (let t = 0; t < 5; t++) {
      await eventLog.append({
        invocationId: `i${t}-0`,
        sessionId: `s${t}`,
        threadId: `tB${t}`,
        catId: 'c1',
        toolName: 'list_recent',
        timestamp: t * 1000,
        turnIndex: 0,
        status: 'success',
        summary: { resultCount: 3, scope: 'docs', since: '7d' },
      });
      for (let i = 1; i < 5; i++) {
        await eventLog.append({
          invocationId: `i${t}-${i}`,
          sessionId: `s${t}`,
          threadId: `tB${t}`,
          catId: 'c1',
          toolName: 'search_evidence',
          timestamp: t * 1000 + i,
          turnIndex: i,
          status: 'success',
          summary: { resultCount: 1, topScore: 0.5, nudgeEmitted: false },
        });
      }
    }

    const threads = Array.from({ length: 5 }, (_, i) => ({ threadId: `tB${i}` }));
    const report = await computeFromThreads(eventLog, threads);
    // Cold-start denominator = 25, numerator = 5 (one list_recent at entry per thread).
    assert.equal(report.listRecentAdoptionRate.sampleN, 25);
    assert.equal(report.listRecentAdoptionRate.value, 20.0, '5/25 = 20% — list_recent used at cold-start entry');
  });

  test('FM-3 cold-start window scopes per (catId, threadId) — parallel cats independent', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 1 thread, 2 cats in parallel. Each cat does 6 memory calls.
    // Cat A: list_recent first then 5 search — list_recent IS in A's cold-start.
    // Cat B: 5 search then list_recent — list_recent NOT in B's cold-start.
    // Each cat contributes 5 cold-start slots → total denominator = 10.
    // Numerator = 1 (only Cat A's list_recent at entry).
    await eventLog.append({
      invocationId: 'iA0',
      sessionId: 'sA',
      threadId: 'tShared',
      catId: 'catA',
      toolName: 'list_recent',
      timestamp: 1,
      turnIndex: 0,
      status: 'success',
      summary: {},
    });
    for (let i = 1; i < 6; i++) {
      await eventLog.append({
        invocationId: `iA${i}`,
        sessionId: 'sA',
        threadId: 'tShared',
        catId: 'catA',
        toolName: 'search_evidence',
        timestamp: i + 1,
        turnIndex: i,
        status: 'success',
        summary: {},
      });
    }
    for (let i = 0; i < 5; i++) {
      await eventLog.append({
        invocationId: `iB${i}`,
        sessionId: 'sB',
        threadId: 'tShared',
        catId: 'catB',
        toolName: 'search_evidence',
        timestamp: 100 + i,
        turnIndex: i,
        status: 'success',
        summary: {},
      });
    }
    await eventLog.append({
      invocationId: 'iBlate',
      sessionId: 'sB',
      threadId: 'tShared',
      catId: 'catB',
      toolName: 'list_recent',
      timestamp: 200,
      turnIndex: 5,
      status: 'success',
      summary: {},
    });

    // Bypass N≥20 by directly inspecting raw counts via a small N override.
    const report = await computeFromThreads(eventLog, [{ threadId: 'tShared' }]);
    assert.equal(report.listRecentAdoptionRate.sampleN, 10, 'cold-start denom = 5 per cat × 2 cats');
    // Below threshold → value=null but sampleN proves per-cat scope worked.
    assert.equal(report.listRecentAdoptionRate.sufficient, false);
  });

  test('FM-5 nudge_failure_rate uses confound排除: failed iff !followed AND grep fallback', async () => {
    const { ToolEventLog } = await import('../dist/domains/cats/services/tool-usage/ToolEventLog.js');
    const { computeFromThreads } = await import('../dist/domains/memory/ToolUsageMetricsAggregator.js');
    const eventLog = new ToolEventLog(redis);

    // 20 nudge events; pattern: 5 followed (graph_resolve next), 5 followed (list_recent),
    // 5 cat ignored but no fallback (正确不试), 5 truly failed (no follow + grep fallback)
    for (let i = 0; i < 20; i++) {
      await eventLog.append({
        invocationId: `i${i}`,
        sessionId: 's1',
        threadId: `t${i}`,
        catId: 'c1',
        toolName: 'search_evidence',
        timestamp: i * 100,
        turnIndex: 0,
        status: 'no_match',
        summary: { resultCount: 0, topScore: null, nudgeEmitted: true },
      });
      if (i < 5) {
        await eventLog.append({
          invocationId: `i${i}b`,
          sessionId: 's1',
          threadId: `t${i}`,
          catId: 'c1',
          toolName: 'graph_resolve',
          timestamp: i * 100 + 10,
          turnIndex: 1,
          status: 'success',
          summary: { candidateCount: 1, rankedCandidateAnchors: ['x'] },
        });
      } else if (i < 10) {
        await eventLog.append({
          invocationId: `i${i}b`,
          sessionId: 's1',
          threadId: `t${i}`,
          catId: 'c1',
          toolName: 'list_recent',
          timestamp: i * 100 + 10,
          turnIndex: 1,
          status: 'success',
          summary: { resultCount: 5, scope: 'all', since: '7d' },
        });
      } else if (i < 15) {
        // Cat正确不试; no grep fallback. NOT counted as failure.
        await eventLog.append({
          invocationId: `i${i}b`,
          sessionId: 's1',
          threadId: `t${i}`,
          catId: 'c1',
          toolName: 'Read',
          timestamp: i * 100 + 10,
          turnIndex: 1,
          status: 'success',
          summary: {},
        });
      } else {
        await eventLog.append({
          invocationId: `i${i}b`,
          sessionId: 's1',
          threadId: `t${i}`,
          catId: 'c1',
          toolName: 'Bash',
          timestamp: i * 100 + 10,
          turnIndex: 1,
          status: 'success',
          summary: { command: 'grep -r foo' },
        });
      }
    }

    const threads = Array.from({ length: 20 }, (_, i) => ({ threadId: `t${i}` }));
    const report = await computeFromThreads(eventLog, threads);
    assert.equal(report.nudgeFailureRate.sufficient, true);
    assert.equal(report.nudgeFailureRate.value, 25.0, '5/20 = 25% truly failed (correct ignore not counted)');
  });
});
