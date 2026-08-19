/**
 * F263 Phase C — AC-C4: Unmet demand collector + AC-C3: first verification events
 *
 * Verifies:
 * 1. classifyUnmetDemand correctly buckets events
 * 2. collectLifecycleTraces produces unmet demand traces from RecallEvents
 * 3. true_zero events also produce verification events (C3 first real events)
 * 4. Events with results do NOT produce unmet demand traces
 * 5. Collector is fail-safe (does not throw on missing table)
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('F263 Phase C: lifecycle collector', () => {
  let db;
  let store;
  let classifyUnmetDemand;
  let collectLifecycleTraces;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const storeModule = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);
    const collectorModule = await import(`../../dist/domains/memory/f263-lifecycle-collector.js?v=${Date.now()}`);

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);

    store = new storeModule.LifecycleTraceStore(db);
    classifyUnmetDemand = collectorModule.classifyUnmetDemand;
    collectLifecycleTraces = collectorModule.collectLifecycleTraces;
  });

  afterEach(() => {
    if (db) db.close();
  });

  // ── classifyUnmetDemand ────────────────────────────────────────────

  describe('classifyUnmetDemand', () => {
    const baseEvent = {
      recallId: 'r1',
      catId: 'opus',
      invocationId: 'inv-1',
      toolName: 'search_evidence',
      source: 'pull',
      presented: true,
      inspected: false,
      outcome: 'ignored',
      query: 'test query',
      candidates: [],
      consumed: [],
      reformulated: false,
      fellBackToGrep: false,
      abandoned: false,
      nextGraphResolveAfterRead: false,
      tokenCost: 0,
      timestamp: Date.now(),
    };

    it('true_zero: resultCount=0, resultStatus=no_results', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: 0,
        resultStatus: 'no_results',
      });
      assert.equal(result, 'true_zero');
    });

    it('null_count: resultCount is null, no resultStatus', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: null,
        resultStatus: undefined,
      });
      assert.equal(result, 'null_count');
    });

    it('null_count: resultCount is undefined', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: undefined,
        resultStatus: undefined,
      });
      assert.equal(result, 'null_count');
    });

    it('not_written: resultStatus=legacy_unknown', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: undefined,
        resultStatus: 'legacy_unknown',
      });
      assert.equal(result, 'not_written');
    });

    it('not_written: resultStatus=result_unmerged', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: undefined,
        resultStatus: 'result_unmerged',
      });
      assert.equal(result, 'not_written');
    });

    it('parser_miss: resultStatus=parser_miss', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: undefined,
        resultStatus: 'parser_miss',
      });
      assert.equal(result, 'parser_miss');
    });

    it('returns null when candidates exist', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        candidates: [{ anchor: 'a1', rank: 0, targetRef: { kind: 'doc', sourcePath: 'p' } }],
        resultCount: 1,
        resultStatus: 'counted',
      });
      assert.equal(result, null);
    });

    it('returns null when resultCount > 0', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: 5,
        resultStatus: 'counted',
      });
      assert.equal(result, null);
    });

    // R7 P2 regression: error/overflow are operational outcomes, not unmet demand
    it('returns null for resultStatus=error (operational failure, not unmet demand)', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: null,
        resultStatus: 'error',
      });
      assert.equal(result, null, 'error must not be classified as null_count');
    });

    it('returns null for resultStatus=overflow with null resultCount', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: null,
        resultStatus: 'overflow',
      });
      assert.equal(result, null, 'overflow must not be classified as null_count');
    });

    it('returns null for resultStatus=error with undefined resultCount', () => {
      const result = classifyUnmetDemand({
        ...baseEvent,
        resultCount: undefined,
        resultStatus: 'error',
      });
      assert.equal(result, null, 'error with undefined resultCount must not leak into null_count');
    });
  });

  // ── collectLifecycleTraces ─────────────────────────────────────────

  describe('collectLifecycleTraces', () => {
    let eventCounter = 0;
    const makeRecallEvent = (overrides = {}) => {
      const idx = eventCounter++;
      return {
        recallId: `r-${Math.random().toString(36).slice(2, 8)}`,
        catId: 'opus',
        invocationId: 'inv-1',
        toolName: 'search_evidence',
        source: 'pull',
        sourceEventId: `inv-1:${idx}`,
        presented: true,
        inspected: false,
        outcome: 'ignored',
        query: 'test query',
        candidates: [],
        consumed: [],
        reformulated: false,
        fellBackToGrep: false,
        abandoned: false,
        nextGraphResolveAfterRead: false,
        tokenCost: 0,
        timestamp: Date.now(),
        ...overrides,
      };
    };

    it('produces unmet demand trace for true_zero event', () => {
      const events = [makeRecallEvent({ resultCount: 0, resultStatus: 'no_results' })];
      const result = collectLifecycleTraces(store, events);

      assert.equal(result.unmetDemandCount, 1);
      assert.equal(result.verificationCount, 1, 'true_zero also produces verification');

      const traces = store.query({ kind: 'unmet_demand', category: 'true_zero' });
      assert.equal(traces.length, 1);
    });

    it('produces unmet demand trace for parser_miss without verification', () => {
      const events = [makeRecallEvent({ resultCount: undefined, resultStatus: 'parser_miss' })];
      const result = collectLifecycleTraces(store, events);

      assert.equal(result.unmetDemandCount, 1);
      assert.equal(result.verificationCount, 0, 'parser_miss does NOT produce verification');

      const traces = store.query({ kind: 'unmet_demand', category: 'parser_miss' });
      assert.equal(traces.length, 1);
    });

    it('does NOT produce traces for events with results', () => {
      const events = [
        makeRecallEvent({
          resultCount: 3,
          resultStatus: 'counted',
          candidates: [{ anchor: 'a1', rank: 0, targetRef: { kind: 'doc', sourcePath: 'p' } }],
        }),
      ];
      const result = collectLifecycleTraces(store, events);

      assert.equal(result.unmetDemandCount, 0);
      assert.equal(result.verificationCount, 0);
    });

    it('true_zero verification event has correct structure', () => {
      const events = [
        makeRecallEvent({
          resultCount: 0,
          resultStatus: 'no_results',
          query: 'how to configure ssl',
          toolName: 'search_evidence',
        }),
      ];
      collectLifecycleTraces(store, events);

      const verifications = store.getVerificationEvents({});
      assert.equal(verifications.length, 1);
      assert.equal(verifications[0].claimKind, 'unmet-demand');
      assert.equal(verifications[0].checkSource, 'recall-correlation-zero-hit');
      assert.equal(verifications[0].verdict, 'confirmed');
      assert.equal(verifications[0].evidence.query, 'how to configure ssl');
    });

    it('handles multiple events in one batch', () => {
      // Each event needs a unique timestamp to produce distinct sourceEventIds.
      // In production, each tool call occurs at a different time.
      const now = Date.now();
      const events = [
        makeRecallEvent({ timestamp: now - 3000, resultCount: 0, resultStatus: 'no_results', query: 'q1' }),
        makeRecallEvent({
          timestamp: now - 2000,
          resultCount: 5,
          resultStatus: 'counted',
          candidates: [{ anchor: 'a', rank: 0, targetRef: { kind: 'doc', sourcePath: 'p' } }],
        }),
        makeRecallEvent({ timestamp: now - 1000, resultCount: undefined, resultStatus: 'parser_miss', query: 'q2' }),
        makeRecallEvent({
          timestamp: now,
          resultCount: 0,
          resultStatus: 'no_results',
          query: 'q3',
          toolName: 'graph_resolve',
        }),
      ];
      const result = collectLifecycleTraces(store, events);

      assert.equal(result.unmetDemandCount, 3, 'two true_zero + one parser_miss');
      assert.equal(result.verificationCount, 2, 'two true_zero verifications');

      const allTraces = store.query({ kind: 'unmet_demand' });
      assert.equal(allTraces.length, 3);

      // Source family mapping
      const graphTrace = allTraces.find((t) => t.sourceFamily === 'graph_resolve');
      assert.ok(graphTrace, 'graph_resolve source family should be mapped');
    });

    it('collector passes sourceEventId from RecallEvent to trace store', () => {
      const events = [
        makeRecallEvent({
          sourceEventId: 'toolu_abc123',
          resultCount: 0,
          resultStatus: 'no_results',
          query: 'stable key test',
        }),
      ];

      collectLifecycleTraces(store, events);

      const traces = store.query({ kind: 'unmet_demand' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].sourceEventId, 'toolu_abc123', 'sourceEventId flows from RecallEvent to trace');
    });

    it('P1 regression: replaying same source events via collector does NOT inflate traces', () => {
      const ts = Date.now();
      const stableId = 'toolu_replay_test';
      // Simulate two calls to collectLifecycleTraces with the same source event
      // but different recallIds (as RecallEventCorrelator.correlateWindow() would produce).
      // Both share the same sourceEventId (set by the correlator).
      const eventsRun1 = [
        makeRecallEvent({
          recallId: 'recall-run-1-uuid',
          sourceEventId: stableId,
          timestamp: ts,
          resultCount: 0,
          resultStatus: 'no_results',
          query: 'replay test',
          threadId: 'thread-1',
        }),
      ];
      const eventsRun2 = [
        makeRecallEvent({
          recallId: 'recall-run-2-uuid', // different recallId from retry!
          sourceEventId: stableId, // same sourceEventId — this is what deduplicates
          timestamp: ts,
          resultCount: 0,
          resultStatus: 'no_results',
          query: 'replay test',
          threadId: 'thread-1',
        }),
      ];

      const result1 = collectLifecycleTraces(store, eventsRun1);
      assert.equal(result1.unmetDemandCount, 1);
      assert.equal(result1.verificationCount, 1);

      // Second run: same sourceEventId, different recallId.
      // Store's INSERT OR IGNORE skips duplicates via UNIQUE(source_event_id, kind).
      collectLifecycleTraces(store, eventsRun2);

      const unmetTraces = store.query({ kind: 'unmet_demand' });
      assert.equal(unmetTraces.length, 1, 'retry must NOT inflate unmet_demand traces');

      const verificationTraces = store.query({ kind: 'verification' });
      assert.equal(verificationTraces.length, 1, 'retry must NOT inflate verification traces');
    });
  });

  // ── P1 regression: triggerRecallCorrelation-level tests ─────────────
  //
  // Terra R3 requirements:
  // 1. Same source event replayed → 1 recall_event, 1 unmet_demand, 1 verification, attentionCost=1
  // 2. Two same-ms same-tool but distinct source events → 2 recall_events, 2 traces each

  describe('P1 regression: triggerRecallCorrelation replay idempotency', () => {
    it('replaying same source events produces no duplicate recall_events, traces, or attention inflation', async () => {
      const { triggerRecallCorrelation } = await import(
        `../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`
      );
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);

      const invocationId = 'inv-p1-regression';
      const catId = 'opus-p1-test';
      const ts = Date.now();

      // Source events: one search_evidence with zero hits
      const sourceEvents = [
        {
          invocationId,
          catId,
          toolName: 'search_evidence',
          timestamp: ts,
          sessionId: 'sess-1',
          threadId: 'thread-p1',
          turnIndex: 0,
          status: 'ok',
          summary: {
            query: 'p1 regression test query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
            scope: 'thread',
          },
        },
      ];

      // Run 1: first correlation
      await triggerRecallCorrelation(db, sourceEvents, invocationId, catId);

      // Run 2: same source events replayed (e.g., hook called again on same invocation)
      await triggerRecallCorrelation(db, sourceEvents, invocationId, catId);

      // Assert: recall_events should have exactly 1 row (dedup via source_event_id)
      const recallRows = db.prepare('SELECT COUNT(*) AS count FROM recall_events').get();
      assert.equal(recallRows.count, 1, 'replayed triggerRecallCorrelation must NOT inflate recall_events');

      // Assert: lifecycle_traces should have exactly 1 unmet_demand + 1 verification
      const traceStore = new LifecycleTraceStore(db);
      const unmetTraces = traceStore.query({ kind: 'unmet_demand' });
      const verificationTraces = traceStore.query({ kind: 'verification' });
      assert.equal(unmetTraces.length, 1, 'must NOT inflate unmet_demand traces');
      assert.equal(verificationTraces.length, 1, 'must NOT inflate verification traces');

      // Assert: three-axis attention cost is 1 (not 2)
      const snapshot = traceStore.computeThreeAxis(7);
      assert.equal(snapshot.attentionCost.value, 1, 'attentionCost must NOT inflate on retry');

      // Assert: sourceEventId uses composite fallback format (no _toolUseId in summary)
      // Format: invocationId:catId:toolName:timestamp:loopIndex
      assert.equal(
        unmetTraces[0].sourceEventId,
        `${invocationId}:${catId}:search_evidence:${ts}:0`,
        'sourceEventId fallback = invocationId:catId:toolName:timestamp:loopIndex',
      );
    });

    it('two same-ms same-tool but distinct source events are NOT merged', async () => {
      const { triggerRecallCorrelation } = await import(
        `../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`
      );
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);

      const invocationId = 'inv-same-ms';
      const catId = 'opus-same-ms';
      const ts = Date.now();

      // Two search_evidence calls at the exact same millisecond, different queries.
      // In real usage: parallel tool calls or sub-ms sequential calls.
      const sourceEvents = [
        {
          invocationId,
          catId,
          toolName: 'search_evidence',
          timestamp: ts,
          sessionId: 'sess-1',
          threadId: 'thread-ms',
          turnIndex: 0,
          status: 'ok',
          summary: {
            query: 'first query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
          },
        },
        {
          invocationId,
          catId,
          toolName: 'search_evidence',
          timestamp: ts, // same millisecond!
          sessionId: 'sess-1',
          threadId: 'thread-ms',
          turnIndex: 1, // different turnIndex
          status: 'ok',
          summary: {
            query: 'second query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
          },
        },
      ];

      await triggerRecallCorrelation(db, sourceEvents, invocationId, catId);

      // Both events should produce their own recall_event and lifecycle traces
      const recallRows = db.prepare('SELECT COUNT(*) AS count FROM recall_events').get();
      assert.equal(recallRows.count, 2, 'two distinct source events must produce 2 recall_events');

      const traceStore = new LifecycleTraceStore(db);
      const unmetTraces = traceStore.query({ kind: 'unmet_demand' });
      assert.equal(unmetTraces.length, 2, 'two distinct source events must produce 2 unmet_demand traces');

      const verificationTraces = traceStore.query({ kind: 'verification' });
      assert.equal(verificationTraces.length, 2, 'two distinct true_zero events must produce 2 verifications');

      // Verify they have distinct sourceEventIds
      const ids = new Set(unmetTraces.map((t) => t.sourceEventId));
      assert.equal(ids.size, 2, 'sourceEventIds must be distinct for distinct source events');
    });

    it('Terra R4: cross-invocation same raw _toolUseId → both persist; same invocation replay → still 1', async () => {
      const { triggerRecallCorrelation } = await import(
        `../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`
      );
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);

      const sharedRawToolUseId = 'toolu_01ABC'; // same raw id from provider
      const ts = Date.now();

      // Invocation A — search_evidence with _toolUseId in summary
      const eventsA = [
        {
          invocationId: 'inv-A',
          catId: 'opus-A',
          toolName: 'search_evidence',
          timestamp: ts,
          sessionId: 'sess-A',
          threadId: 'thread-r4',
          turnIndex: 0,
          status: 'ok',
          summary: {
            query: 'invocation A query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
            _toolUseId: sharedRawToolUseId,
          },
        },
      ];

      // Invocation B — different invocation, same raw _toolUseId (provider reuses ids)
      const eventsB = [
        {
          invocationId: 'inv-B',
          catId: 'opus-B',
          toolName: 'search_evidence',
          timestamp: ts + 1000,
          sessionId: 'sess-B',
          threadId: 'thread-r4',
          turnIndex: 0,
          status: 'ok',
          summary: {
            query: 'invocation B query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
            _toolUseId: sharedRawToolUseId,
          },
        },
      ];

      // Correlate both invocations
      await triggerRecallCorrelation(db, eventsA, 'inv-A', 'opus-A');
      await triggerRecallCorrelation(db, eventsB, 'inv-B', 'opus-B');

      // Both must persist — raw _toolUseId collision must NOT cause silent drop
      const recallRows = db.prepare('SELECT * FROM recall_events ORDER BY timestamp').all();
      assert.equal(recallRows.length, 2, 'cross-invocation same raw _toolUseId → 2 recall_events');

      const traceStore = new LifecycleTraceStore(db);
      const unmetTraces = traceStore.query({ kind: 'unmet_demand' });
      assert.equal(unmetTraces.length, 2, 'cross-invocation same raw _toolUseId → 2 unmet_demand traces');

      const verificationTraces = traceStore.query({ kind: 'verification' });
      assert.equal(verificationTraces.length, 2, 'cross-invocation same raw _toolUseId → 2 verification traces');

      // sourceEventIds must be distinct (namespaced by invocationId:catId)
      const sourceIds = new Set(recallRows.map((r) => r.source_event_id));
      assert.equal(sourceIds.size, 2, 'sourceEventIds namespaced → distinct');
      assert.ok(
        [...sourceIds].every((id) => id.includes(sharedRawToolUseId)),
        'both sourceEventIds contain the raw _toolUseId',
      );
      assert.ok(
        [...sourceIds].some((id) => id.startsWith('inv-A:')),
        'one is namespaced to inv-A',
      );
      assert.ok(
        [...sourceIds].some((id) => id.startsWith('inv-B:')),
        'one is namespaced to inv-B',
      );

      // Now replay invocation A — must NOT inflate
      await triggerRecallCorrelation(db, eventsA, 'inv-A', 'opus-A');

      const afterReplay = db.prepare('SELECT COUNT(*) AS count FROM recall_events').get();
      assert.equal(afterReplay.count, 2, 'replay of inv-A must NOT inflate recall_events');

      const afterReplayTraces = traceStore.query({ kind: 'unmet_demand' });
      assert.equal(afterReplayTraces.length, 2, 'replay of inv-A must NOT inflate traces');
    });

    it('R5 P1: multiple memory calls with turnIndex=0 (no provider turnIndex) → all persist', async () => {
      const { triggerRecallCorrelation } = await import(
        `../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`
      );
      const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);

      const invocationId = 'inv-turnindex-zero';
      const catId = 'opus-ti0';
      const ts = Date.now();

      // Simulate route-parallel.ts:1126 fallback: turnIndex: msg.turnIndex ?? 0
      // Both memory calls get turnIndex=0 because provider didn't set msg.turnIndex.
      // Without the composite fallback key, both would get sourceEventId="inv:0" → collision.
      const sourceEvents = [
        {
          invocationId,
          catId,
          toolName: 'search_evidence',
          timestamp: ts,
          sessionId: 'sess-1',
          threadId: 'thread-ti0',
          turnIndex: 0, // <-- fallback from route layer
          status: 'ok',
          summary: {
            query: 'first zero-hit query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
            // no _toolUseId — fallback path
          },
        },
        {
          invocationId,
          catId,
          toolName: 'list_recent',
          timestamp: ts + 500,
          sessionId: 'sess-1',
          threadId: 'thread-ti0',
          turnIndex: 0, // <-- same turnIndex=0!
          status: 'ok',
          summary: {
            query: 'second zero-hit query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
          },
        },
        {
          invocationId,
          catId,
          toolName: 'search_evidence',
          timestamp: ts + 500, // same-ms as second, same tool as first
          sessionId: 'sess-1',
          threadId: 'thread-ti0',
          turnIndex: 0, // <-- same turnIndex=0!
          status: 'ok',
          summary: {
            query: 'third zero-hit query',
            resultCount: 0,
            resultStatus: 'no_results',
            mode: 'hybrid',
          },
        },
      ];

      await triggerRecallCorrelation(db, sourceEvents, invocationId, catId);

      // All 3 events must produce their own recall_event (not silently dropped)
      const recallRows = db.prepare('SELECT COUNT(*) AS count FROM recall_events').get();
      assert.equal(recallRows.count, 3, 'all 3 memory calls with turnIndex=0 must persist');

      const traceStore = new LifecycleTraceStore(db);
      const unmetTraces = traceStore.query({ kind: 'unmet_demand' });
      assert.equal(unmetTraces.length, 3, 'all 3 must produce unmet_demand traces');

      // sourceEventIds must all be distinct
      const sourceIds = new Set(
        db
          .prepare('SELECT source_event_id FROM recall_events')
          .all()
          .map((r) => r.source_event_id),
      );
      assert.equal(sourceIds.size, 3, 'composite fallback keys must be distinct despite turnIndex=0');

      // Replay: same events → still 3 (dedup works)
      await triggerRecallCorrelation(db, sourceEvents, invocationId, catId);
      const afterReplay = db.prepare('SELECT COUNT(*) AS count FROM recall_events').get();
      assert.equal(afterReplay.count, 3, 'replay must NOT inflate past 3');
    });
  });
});
