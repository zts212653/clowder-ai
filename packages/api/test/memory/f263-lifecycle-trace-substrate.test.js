/**
 * F263 Phase C — AC-C1: Lifecycle trace substrate
 *
 * Verifies:
 * 1. Append-only: INSERT works, UPDATE/DELETE raise ABORT
 * 2. Shadow isolation: lifecycle_traces are NOT searchable via evidence search
 * 3. Query by kind, category, source_family, time range
 * 4. Harmful consumption day-1 categories: stale-pointer, identity-misbinding
 * 5. V33 migration applies cleanly on top of V32
 *
 * AC-C3: Verification events
 * 6. verificationEvents[] schema: target/claim kind/check source/observedAt/verdict
 * 7. First real verification events insert + query
 *
 * AC-C4: True-zero unmet demand
 * 8. Only F200 observed resultCount=0 → true_zero bucket
 * 9. NULL / not-written / parser-miss → separate buckets
 * 10. Query trace storable:false / indexable:false (shadow isolation)
 * 11. Queryable by source family
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('F263 Phase C: lifecycle trace substrate', () => {
  let db;
  let store;

  beforeEach(async () => {
    const Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');
    const { LifecycleTraceStore } = await import(`../../dist/domains/memory/LifecycleTraceStore.js?v=${Date.now()}`);

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);

    store = new LifecycleTraceStore(db);
  });

  afterEach(() => {
    if (db) db.close();
  });

  // ── C1: Append-only enforcement ────────────────────────────────────

  describe('AC-C1: append-only enforcement', () => {
    it('INSERT succeeds and returns a trace_id', () => {
      const traceId = store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: Date.now(),
      });
      assert.ok(traceId, 'trace_id should be non-empty');
      assert.match(traceId, /^[0-9a-f-]{36}$/, 'trace_id should be a UUID');
    });

    it('UPDATE raises ABORT (append-only trigger)', () => {
      const traceId = store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: Date.now(),
      });

      assert.throws(
        () => {
          db.prepare('UPDATE lifecycle_traces SET category = ? WHERE trace_id = ?').run('identity-misbinding', traceId);
        },
        (err) => err.message.includes('lifecycle traces are append-only'),
        'UPDATE should be rejected by append-only trigger',
      );
    });

    it('DELETE raises ABORT (append-only trigger)', () => {
      const traceId = store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: Date.now(),
      });

      assert.throws(
        () => {
          db.prepare('DELETE FROM lifecycle_traces WHERE trace_id = ?').run(traceId);
        },
        (err) => err.message.includes('lifecycle traces are append-only'),
        'DELETE should be rejected by append-only trigger',
      );
    });
  });

  // ── C1: Shadow isolation — lifecycle traces NOT in evidence search ─

  describe('AC-C1: shadow isolation red test', () => {
    it('lifecycle_traces records do NOT appear in evidence_docs', () => {
      // Insert a lifecycle trace
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        targetAnchor: 'test-anchor-shadow',
        observedAt: Date.now(),
      });

      // Verify it's in lifecycle_traces
      const traceCount = db.prepare('SELECT COUNT(*) AS c FROM lifecycle_traces').get();
      assert.equal(traceCount.c, 1, 'trace should exist in lifecycle_traces');

      // Verify it's NOT in evidence_docs
      const evidenceCount = db
        .prepare("SELECT COUNT(*) AS c FROM evidence_docs WHERE anchor = 'test-anchor-shadow'")
        .get();
      assert.equal(evidenceCount.c, 0, 'trace MUST NOT appear in evidence_docs');
    });

    it('lifecycle_traces records do NOT appear in evidence_fts', () => {
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        targetAnchor: 'stale-pointer-target',
        payload: { description: 'a harmful consumption event' },
        observedAt: Date.now(),
      });

      // FTS5 search must not hit lifecycle traces
      const ftsResults = db.prepare("SELECT COUNT(*) AS c FROM evidence_fts WHERE evidence_fts MATCH 'harmful'").get();
      assert.equal(ftsResults.c, 0, 'lifecycle traces MUST NOT be searchable via FTS');
    });
  });

  // ── C1: Query functionality ────────────────────────────────────────

  describe('AC-C1: query by kind/category/source/time', () => {
    it('query by kind returns only matching traces', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'verification', sourceFamily: 'search_evidence', observedAt: now });

      const harmful = store.query({ kind: 'harmful_consumption' });
      assert.equal(harmful.length, 1);
      assert.equal(harmful[0].kind, 'harmful_consumption');

      const unmet = store.query({ kind: 'unmet_demand' });
      assert.equal(unmet.length, 1);
      assert.equal(unmet[0].kind, 'unmet_demand');
    });

    it('query by category returns only matching traces', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'identity-misbinding',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });

      const stale = store.query({ kind: 'harmful_consumption', category: 'stale-pointer' });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].category, 'stale-pointer');
    });

    it('query by source_family returns only matching traces', () => {
      const now = Date.now();
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'graph_resolve', observedAt: now });

      const se = store.query({ sourceFamily: 'search_evidence' });
      assert.equal(se.length, 1);
      assert.equal(se[0].sourceFamily, 'search_evidence');
    });

    it('query by time range returns only traces in range', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 5000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now + 5000,
      });

      const inRange = store.query({ from: now - 3000, to: now });
      assert.equal(inRange.length, 1);
      assert.equal(inRange[0].observedAt, now - 1000);
    });

    it('query returns traces ordered by observed_at DESC', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 2000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });

      const all = store.query({ kind: 'harmful_consumption' });
      assert.equal(all.length, 3);
      assert.ok(all[0].observedAt >= all[1].observedAt, 'should be DESC');
      assert.ok(all[1].observedAt >= all[2].observedAt, 'should be DESC');
    });
  });

  // ── C1: Day-1 harmful categories ──────────────────────────────────

  describe('AC-C1: harmful consumption day-1 categories', () => {
    it('stale-pointer trace roundtrips correctly', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        recallId: 'recall-123',
        targetAnchor: 'docs/old-design.md',
        payload: { reason: 'anchor references deleted file', staleSince: '2026-06-01' },
        observedAt: now,
      });

      const traces = store.query({ kind: 'harmful_consumption', category: 'stale-pointer' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'stale-pointer');
      assert.equal(traces[0].recallId, 'recall-123');
      assert.equal(traces[0].targetAnchor, 'docs/old-design.md');
      assert.equal(traces[0].payload.reason, 'anchor references deleted file');
    });

    it('identity-misbinding trace roundtrips correctly', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'identity-misbinding',
        sourceFamily: 'session_bootstrap',
        recallId: 'recall-456',
        targetAnchor: 'entity:cat-opus',
        payload: { reason: 'entity alias matched wrong cat', expectedCat: 'fable-5', matchedCat: 'opus-46' },
        observedAt: now,
      });

      const traces = store.query({ kind: 'harmful_consumption', category: 'identity-misbinding' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'identity-misbinding');
      assert.equal(traces[0].payload.reason, 'entity alias matched wrong cat');
    });
  });

  // ── C3: Verification events ────────────────────────────────────────

  describe('AC-C3: verificationEvents[] schema and first events', () => {
    it('verification event with all fields roundtrips correctly', () => {
      const now = Date.now();
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'docs/decisions/ADR-001.md',
        claimKind: 'stale-pointer',
        checkSource: 'file-existence-check',
        verdict: 'confirmed',
        payload: { checkedPath: 'docs/decisions/ADR-001.md', exists: false },
        observedAt: now,
      });

      const events = store.getVerificationEvents({ targetAnchor: 'docs/decisions/ADR-001.md' });
      assert.equal(events.length, 1);
      assert.equal(events[0].target, 'docs/decisions/ADR-001.md');
      assert.equal(events[0].claimKind, 'stale-pointer');
      assert.equal(events[0].checkSource, 'file-existence-check');
      assert.equal(events[0].verdict, 'confirmed');
      assert.deepEqual(events[0].evidence, { checkedPath: 'docs/decisions/ADR-001.md', exists: false });
    });

    it('getVerificationEvents filters by time range', () => {
      const now = Date.now();
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'anchor-1',
        claimKind: 'stale-pointer',
        checkSource: 'manual',
        verdict: 'refuted',
        observedAt: now - 10000,
      });
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'anchor-1',
        claimKind: 'identity-misbinding',
        checkSource: 'automated',
        verdict: 'confirmed',
        observedAt: now,
      });

      const recent = store.getVerificationEvents({
        targetAnchor: 'anchor-1',
        from: now - 5000,
      });
      assert.equal(recent.length, 1);
      assert.equal(recent[0].claimKind, 'identity-misbinding');
    });

    it('verification events do not include evidence when payload is empty', () => {
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        targetAnchor: 'anchor-2',
        claimKind: 'stale-pointer',
        checkSource: 'check',
        verdict: 'inconclusive',
        observedAt: Date.now(),
      });

      const events = store.getVerificationEvents({ targetAnchor: 'anchor-2' });
      assert.equal(events.length, 1);
      assert.equal(events[0].evidence, undefined, 'empty payload should not produce evidence field');
    });

    it('three verdict types are accepted', () => {
      const now = Date.now();
      for (const verdict of ['confirmed', 'refuted', 'inconclusive']) {
        store.append({
          kind: 'verification',
          sourceFamily: 'search_evidence',
          targetAnchor: `anchor-${verdict}`,
          claimKind: 'stale-pointer',
          checkSource: 'test',
          verdict,
          observedAt: now,
        });
      }

      const all = store.query({ kind: 'verification' });
      assert.equal(all.length, 3);
      const verdicts = new Set(all.map((t) => t.verdict));
      assert.ok(verdicts.has('confirmed'));
      assert.ok(verdicts.has('refuted'));
      assert.ok(verdicts.has('inconclusive'));
    });
  });

  // ── C4: True-zero unmet demand ─────────────────────────────────────

  describe('AC-C4: true-zero unmet demand trace', () => {
    it('true_zero bucket: F200 observed resultCount=0', () => {
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'recall-zero-1',
        queryText: 'how to configure redis sentinel',
        observedAt: Date.now(),
      });

      const traces = store.query({ kind: 'unmet_demand', category: 'true_zero' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'true_zero');
      assert.equal(traces[0].queryText, 'how to configure redis sentinel');
    });

    it('null_count bucket: resultCount was NULL', () => {
      store.append({
        kind: 'unmet_demand',
        category: 'null_count',
        sourceFamily: 'search_evidence',
        recallId: 'recall-null-1',
        observedAt: Date.now(),
      });

      const traces = store.query({ kind: 'unmet_demand', category: 'null_count' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'null_count');
    });

    it('not_written bucket: resultStatus was legacy_unknown', () => {
      store.append({
        kind: 'unmet_demand',
        category: 'not_written',
        sourceFamily: 'graph_resolve',
        recallId: 'recall-legacy-1',
        observedAt: Date.now(),
      });

      const traces = store.query({ kind: 'unmet_demand', category: 'not_written' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'not_written');
    });

    it('parser_miss bucket: resultStatus was parser_miss', () => {
      store.append({
        kind: 'unmet_demand',
        category: 'parser_miss',
        sourceFamily: 'search_evidence',
        recallId: 'recall-parser-1',
        observedAt: Date.now(),
      });

      const traces = store.query({ kind: 'unmet_demand', category: 'parser_miss' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].category, 'parser_miss');
    });

    it('four buckets are mutually exclusive — only true_zero enters FN denominator', () => {
      const now = Date.now();
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'null_count', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'not_written', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'parser_miss', sourceFamily: 'search_evidence', observedAt: now });

      const allUnmet = store.query({ kind: 'unmet_demand' });
      assert.equal(allUnmet.length, 4);

      const trueZeros = store.query({ kind: 'unmet_demand', category: 'true_zero' });
      assert.equal(trueZeros.length, 1, 'only true_zero enters FN denominator');
    });

    it('unmet demand traces are queryable by source family', () => {
      const now = Date.now();
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'search_evidence', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'graph_resolve', observedAt: now });
      store.append({ kind: 'unmet_demand', category: 'true_zero', sourceFamily: 'list_recent', observedAt: now });

      const se = store.query({ kind: 'unmet_demand', sourceFamily: 'search_evidence' });
      assert.equal(se.length, 1);
      assert.equal(se[0].sourceFamily, 'search_evidence');

      const gr = store.query({ kind: 'unmet_demand', sourceFamily: 'graph_resolve' });
      assert.equal(gr.length, 1);
    });

    it('unmet demand query text is stored but NOT searchable via evidence', () => {
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        queryText: 'secret deployment credentials',
        observedAt: Date.now(),
      });

      // Stored
      const traces = store.query({ kind: 'unmet_demand' });
      assert.equal(traces[0].queryText, 'secret deployment credentials');

      // NOT in evidence search
      const evidenceHits = db
        .prepare("SELECT COUNT(*) AS c FROM evidence_fts WHERE evidence_fts MATCH 'deployment'")
        .get();
      assert.equal(evidenceHits.c, 0, 'query text MUST NOT be searchable via evidence FTS');
    });
  });

  // ── Three-axis computation ─────────────────────────────────────────

  describe('three-axis computation', () => {
    it('returns no-data maturity when no traces exist', () => {
      const snapshot = store.computeThreeAxis(7);
      assert.equal(snapshot.harmfulConsumption.value, 0);
      assert.equal(snapshot.harmfulConsumption.maturity, 'no-data');
      assert.ok(snapshot.harmfulConsumption.reason, 'no-data should have a reason');

      assert.equal(snapshot.unmetDemandLowerBound.value, 0);
      assert.equal(snapshot.unmetDemandLowerBound.maturity, 'no-data');

      assert.equal(snapshot.attentionCost.value, 0);
      assert.equal(snapshot.attentionCost.maturity, 'no-data');
    });

    it('harmful consumption axis counts stale-pointer + identity-misbinding', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'identity-misbinding',
        sourceFamily: 'session_bootstrap',
        observedAt: now - 2000,
      });

      const snapshot = store.computeThreeAxis(7);
      assert.equal(snapshot.harmfulConsumption.value, 2);
      assert.equal(snapshot.harmfulConsumption.maturity, 'measured');
    });

    it('unmet demand axis only counts true_zero, not other buckets', () => {
      const now = Date.now();
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'null_count',
        sourceFamily: 'search_evidence',
        observedAt: now - 2000,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'parser_miss',
        sourceFamily: 'search_evidence',
        observedAt: now - 3000,
      });

      const snapshot = store.computeThreeAxis(7);
      assert.equal(snapshot.unmetDemandLowerBound.value, 1, 'only true_zero');
      assert.equal(snapshot.unmetDemandLowerBound.maturity, 'lower-bound');
      assert.ok(snapshot.unmetDemandLowerBound.reason?.includes('下界'));
    });

    it('attention cost axis reads from recall_events', () => {
      const now = Date.now();
      // Seed some recall events
      const insertRecall = db.prepare(
        `INSERT INTO recall_events
          (recall_id, cat_id, invocation_id, tool_name, query, candidates_json,
           consumed_json, reformulated, fell_back_to_grep, abandoned,
           next_graph_resolve_after_read, token_cost, timestamp,
           source, presented, inspected, outcome)
         VALUES (?, ?, ?, ?, ?, '[]', '[]', 0, 0, 0, 0, 0, ?, 'pull', 1, ?, ?)`,
      );
      insertRecall.run('r1', 'opus', 'inv-1', 'search_evidence', 'q1', now - 1000, 1, 'used');
      insertRecall.run('r2', 'opus', 'inv-2', 'search_evidence', 'q2', now - 2000, 0, 'ignored');
      insertRecall.run('r3', 'opus', 'inv-3', 'search_evidence', 'q3', now - 3000, 0, 'ignored');

      const snapshot = store.computeThreeAxis(7);
      assert.equal(snapshot.attentionCost.value, 2, 'two ignored events');
      assert.equal(snapshot.attentionCost.maturity, 'measured');
    });

    it('snapshot MUST NOT include a total score (禁总分)', () => {
      const snapshot = store.computeThreeAxis(7);
      assert.equal(snapshot.totalScore, undefined, 'total score is forbidden');
      assert.equal(snapshot.score, undefined, 'score is forbidden');
      assert.equal(snapshot.overall, undefined, 'overall is forbidden');
    });

    it('time window is respected', () => {
      const now = Date.now();
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: eightDaysAgo,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });

      const snapshot7 = store.computeThreeAxis(7);
      assert.equal(snapshot7.harmfulConsumption.value, 1, 'only recent trace in 7d window');

      const snapshot30 = store.computeThreeAxis(30);
      assert.equal(snapshot30.harmfulConsumption.value, 2, 'both traces in 30d window');
    });
  });

  // ── V33 migration ──────────────────────────────────────────────────

  describe('V33 migration', () => {
    it('schema_version includes the V33 lifecycle migration', () => {
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      assert.ok(row.v >= 33);
    });

    it('lifecycle_traces table has all expected columns', () => {
      const columns = db.prepare("PRAGMA table_info('lifecycle_traces')").all();
      const names = columns.map((c) => c.name);
      for (const expected of [
        'trace_id',
        'kind',
        'category',
        'source_family',
        'recall_id',
        'thread_id',
        'target_anchor',
        'query_text',
        'claim_kind',
        'check_source',
        'verdict',
        'payload_json',
        'observed_at',
        'created_at',
      ]) {
        assert.ok(names.includes(expected), `column ${expected} should exist`);
      }
    });

    it('indexes exist for queryability', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lifecycle_traces'")
        .all();
      const indexNames = indexes.map((i) => i.name);
      assert.ok(indexNames.includes('idx_lifecycle_traces_kind'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_category'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_source'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_recall'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_target'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_thread'));
      assert.ok(indexNames.includes('idx_lifecycle_traces_source_event_dedup'));
    });

    it('append-only triggers exist', () => {
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'lifecycle_traces'")
        .all();
      const names = triggers.map((t) => t.name);
      assert.ok(names.includes('lifecycle_traces_no_update'));
      assert.ok(names.includes('lifecycle_traces_no_delete'));
    });
  });

  // ── countByKind ────────────────────────────────────────────────────

  describe('countByKind', () => {
    it('returns zero counts when no traces exist', () => {
      const now = Date.now();
      const counts = store.countByKind(now - 86400000, now);
      assert.equal(counts.harmful_consumption, 0);
      assert.equal(counts.unmet_demand, 0);
      assert.equal(counts.verification, 0);
      assert.equal(counts.attention_cost, 0);
    });

    it('counts traces correctly by kind', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now - 1000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'identity-misbinding',
        sourceFamily: 'search_evidence',
        observedAt: now - 2000,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        observedAt: now - 3000,
      });
      store.append({ kind: 'verification', sourceFamily: 'search_evidence', observedAt: now - 4000 });

      const counts = store.countByKind(now - 86400000, now);
      assert.equal(counts.harmful_consumption, 2);
      assert.equal(counts.unmet_demand, 1);
      assert.equal(counts.verification, 1);
      assert.equal(counts.attention_cost, 0);
    });
  });

  // ── P1 fix: idempotency on retry via source_event_id ──────────────
  //
  // Root cause: RecallEventCorrelator.correlateWindow() generates a new
  // randomUUID() recallId per call. When triggerRecallCorrelation() is
  // replayed for the same source events, it produces different recallIds,
  // so UNIQUE(recall_id, kind) was useless for real retry dedup.
  //
  // Fix: use a stable source_event_id derived from
  // (invocationId:toolName:timestamp) — deterministic across retries.
  // UNIQUE(source_event_id, kind) WHERE source_event_id IS NOT NULL.

  describe('P1 fix: append idempotency via (source_event_id, kind) dedup', () => {
    it('duplicate (source_event_id, kind) is silently skipped', () => {
      const now = Date.now();
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'recall-first-run',
        sourceEventId: 'inv-1:search_evidence:1000',
        threadId: 'thread-1',
        observedAt: now,
      });
      // Retry: different recallId (correlator generated new UUID), but same sourceEventId
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'recall-second-run',
        sourceEventId: 'inv-1:search_evidence:1000',
        threadId: 'thread-1',
        observedAt: now,
      });

      const traces = store.query({ kind: 'unmet_demand' });
      assert.equal(traces.length, 1, 'retry with different recallId but same sourceEventId must NOT inflate');
    });

    it('same source_event_id with different kind is allowed (unmet_demand + verification)', () => {
      const now = Date.now();
      const key = 'inv-mk:search_evidence:2000';
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'recall-mk-1',
        sourceEventId: key,
        threadId: 'thread-1',
        observedAt: now,
      });
      store.append({
        kind: 'verification',
        sourceFamily: 'search_evidence',
        recallId: 'recall-mk-1',
        sourceEventId: key,
        threadId: 'thread-1',
        claimKind: 'unmet-demand',
        checkSource: 'recall-correlation-zero-hit',
        verdict: 'confirmed',
        observedAt: now,
      });

      const unmet = store.query({ kind: 'unmet_demand' });
      const verif = store.query({ kind: 'verification' });
      assert.equal(unmet.length, 1);
      assert.equal(verif.length, 1, 'different kinds with same source_event_id must both persist');
    });

    it('null source_event_id traces are NOT deduplicated', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        observedAt: now,
      });

      const traces = store.query({ kind: 'harmful_consumption' });
      assert.equal(traces.length, 2, 'null source_event_id traces should not be deduplicated');
    });

    it('different source_event_ids with same kind both persist', () => {
      const now = Date.now();
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'r-a',
        sourceEventId: 'inv-1:search_evidence:1000',
        threadId: 'thread-1',
        observedAt: now,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        recallId: 'r-b',
        sourceEventId: 'inv-1:search_evidence:2000',
        threadId: 'thread-1',
        observedAt: now,
      });

      const traces = store.query({ kind: 'unmet_demand' });
      assert.equal(traces.length, 2, 'distinct source events must each produce a trace');
    });
  });

  // ── P0 fix: thread_id scoping ─────────────────────────────────────

  describe('P0 fix: thread_id scoping', () => {
    it('threadId is stored and retrievable', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-abc',
        observedAt: now,
      });

      const traces = store.query({ kind: 'harmful_consumption' });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].threadId, 'thread-abc');
    });

    it('query with threadIds filter scopes results', () => {
      const now = Date.now();
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        threadId: 'thread-a',
        recallId: 'r-a',
        observedAt: now,
      });
      store.append({
        kind: 'unmet_demand',
        category: 'true_zero',
        sourceFamily: 'search_evidence',
        threadId: 'thread-b',
        recallId: 'r-b',
        observedAt: now,
      });

      const scopedA = store.query({ kind: 'unmet_demand', threadIds: ['thread-a'] });
      assert.equal(scopedA.length, 1);
      assert.equal(scopedA[0].threadId, 'thread-a');

      const scopedBoth = store.query({ kind: 'unmet_demand', threadIds: ['thread-a', 'thread-b'] });
      assert.equal(scopedBoth.length, 2);
    });

    it('computeThreeAxis scopes by threadIds', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-user-a',
        observedAt: now - 1000,
      });
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-user-b',
        observedAt: now - 2000,
      });

      // User A sees only their thread's traces
      const snapshotA = store.computeThreeAxis(7, ['thread-user-a']);
      assert.equal(snapshotA.harmfulConsumption.value, 1);

      // User B sees only their thread's traces
      const snapshotB = store.computeThreeAxis(7, ['thread-user-b']);
      assert.equal(snapshotB.harmfulConsumption.value, 1);

      // No scoping (internal/test use) sees both
      const snapshotAll = store.computeThreeAxis(7);
      assert.equal(snapshotAll.harmfulConsumption.value, 2);
    });

    it('computeThreeAxis with empty threadIds returns zero (fail-closed)', () => {
      const now = Date.now();
      store.append({
        kind: 'harmful_consumption',
        category: 'stale-pointer',
        sourceFamily: 'search_evidence',
        threadId: 'thread-exists',
        observedAt: now - 1000,
      });

      const snapshot = store.computeThreeAxis(7, []);
      assert.equal(snapshot.harmfulConsumption.value, 0, 'empty threadIds = no access');
    });
  });
});
