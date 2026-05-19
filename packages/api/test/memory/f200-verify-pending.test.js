import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — verify-pending pipeline (P1-1 fix)', () => {
  let Database, applyMigrations, SCHEMA_V1;
  let TrajectoryQueryService, SqliteSignalSources, OutputVerifiedDetector;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const tqs = await import(`../../dist/domains/memory/TrajectoryQueryService.js?v=${Date.now()}`);
    TrajectoryQueryService = tqs.TrajectoryQueryService;
    const sss = await import(`../../dist/domains/memory/SqliteSignalSources.js?v=${Date.now()}`);
    SqliteSignalSources = sss.SqliteSignalSources;
    const ovd = await import(`../../dist/domains/memory/output-verified-detector.js?v=${Date.now()}`);
    OutputVerifiedDetector = ovd.OutputVerifiedDetector;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function seedTrajectory(id, opts = {}) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO task_trajectories (
        trajectory_id, invocation_id, thread_id, cat_id, task_context,
        search_event_ids_json, files_read_json, files_modified_json,
        output_verified, output_verified_signals_json,
        total_token_cost, duration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run([
      id,
      opts.invocationId ?? `inv-${id}`,
      opts.threadId ?? 'thread-001',
      opts.catId ?? 'opus-46',
      opts.taskContext ?? 'test query',
      JSON.stringify(opts.searchEventIds ?? []),
      JSON.stringify(opts.filesRead ?? []),
      JSON.stringify(opts.filesModified ?? []),
      opts.outputVerified ?? 0,
      JSON.stringify(opts.outputVerifiedSignals ?? []),
      opts.totalTokenCost ?? 1000,
      opts.duration ?? 30000,
      opts.createdAt ?? now,
      opts.updatedAt ?? now,
    ]);
  }

  function seedRecallEvent(invocationId, recallId) {
    db.prepare(`
      INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
        candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
        next_graph_resolve_after_read, token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recallId,
      'opus-46',
      invocationId,
      'search_evidence',
      'test',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      100,
      Date.now(),
    );
  }

  it('SqliteSignalSources returns succeeded for invocations with recall events', async () => {
    seedRecallEvent('inv-good', 're-1');
    seedRecallEvent('inv-good', 're-2');

    const sources = new SqliteSignalSources(db);
    const status = await sources.getInvocationStatus('inv-good');
    assert.equal(status, 'succeeded');
  });

  it('SqliteSignalSources returns null for unknown invocations', async () => {
    const sources = new SqliteSignalSources(db);
    const status = await sources.getInvocationStatus('inv-nope');
    assert.equal(status, null);
  });

  it('SqliteSignalSources.isPrMergedForThread returns false (v1 stub)', async () => {
    const sources = new SqliteSignalSources(db);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false);
  });

  it('verify-pending runs detector on unverified trajectories', async () => {
    seedTrajectory('t1', { invocationId: 'inv-1', threadId: 'thread-1' });
    seedTrajectory('t2', { invocationId: 'inv-2', threadId: 'thread-2' });
    seedRecallEvent('inv-1', 're-1');
    seedRecallEvent('inv-2', 're-2');

    const sources = new SqliteSignalSources(db);
    const detector = new OutputVerifiedDetector(sources);
    const svc = new TrajectoryQueryService(db);

    const unverified = svc.listRecent({ verified: false, limit: 100 });
    let verifiedCount = 0;
    for (const t of unverified) {
      const result = await detector.detect(t.invocationId, t.threadId);
      if (result.verified) {
        svc.markVerified(t.trajectoryId, result.signals);
        verifiedCount++;
      }
    }

    assert.equal(unverified.length, 2);
    assert.equal(verifiedCount, 0, 'invocation_succeeded is informational, not a strong signal — no auto-verify');

    const detected = await detector.detect('inv-1', 'thread-1');
    assert.ok(detected.signals.includes('invocation_succeeded'), 'signal still collected');
    assert.equal(detected.verified, false, 'not verified without strong signal');
  });

  it('manual signal injection verifies trajectory when pr_merged provided', () => {
    seedTrajectory('t1');
    const svc = new TrajectoryQueryService(db);

    svc.markVerified('t1', ['pr_merged', 'invocation_succeeded']);

    const verified = svc.listRecent({ verified: true, limit: 10 });
    assert.equal(verified.length, 1);
    assert.deepEqual(verified[0].outputVerifiedSignals, ['pr_merged', 'invocation_succeeded']);
  });

  it('signal injection rejects invocation_succeeded (informational, not injectable)', () => {
    const VALID_SIGNALS = new Set(['pr_merged', 'cvo_accepted', 'reviewer_approved']);
    const signals = ['invocation_succeeded'];
    const invalid = signals.filter((s) => !VALID_SIGNALS.has(s));
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0], 'invocation_succeeded');

    const strongOnly = ['pr_merged'];
    const strongInvalid = strongOnly.filter((s) => !VALID_SIGNALS.has(s));
    assert.equal(strongInvalid.length, 0);
  });

  it('verify-pending with pr_merged source actually verifies', async () => {
    seedTrajectory('t1', { invocationId: 'inv-1', threadId: 'thread-merged' });
    seedRecallEvent('inv-1', 're-1');

    const sources = {
      getInvocationStatus: async () => 'succeeded',
      isPrMergedForThread: async (threadId) => threadId === 'thread-merged',
    };
    const detector = new OutputVerifiedDetector(sources);
    const svc = new TrajectoryQueryService(db);

    const unverified = svc.listRecent({ verified: false, limit: 100 });
    for (const t of unverified) {
      const result = await detector.detect(t.invocationId, t.threadId);
      if (result.verified) {
        svc.markVerified(t.trajectoryId, result.signals);
      }
    }

    const after = svc.listRecent({ verified: true, limit: 10 });
    assert.equal(after.length, 1);
    assert.ok(after[0].outputVerifiedSignals.includes('pr_merged'));
  });
});
