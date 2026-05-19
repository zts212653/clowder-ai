import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — trajectory query helpers', () => {
  let Database, applyMigrations, SCHEMA_V1, TrajectoryQueryService;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const mod = await import(`../../dist/domains/memory/TrajectoryQueryService.js?v=${Date.now()}`);
    TrajectoryQueryService = mod.TrajectoryQueryService;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function seedTrajectory(id, opts = {}) {
    const now = Date.now();
    const params = [
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
    ];
    db.prepare(`
      INSERT INTO task_trajectories (
        trajectory_id, invocation_id, thread_id, cat_id, task_context,
        search_event_ids_json, files_read_json, files_modified_json,
        output_verified, output_verified_signals_json,
        total_token_cost, duration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(params);
  }

  it('lists recent trajectories', () => {
    seedTrajectory('t1');
    seedTrajectory('t2');
    const svc = new TrajectoryQueryService(db);
    const results = svc.listRecent({ limit: 10 });
    assert.equal(results.length, 2);
  });

  it('filters by catId', () => {
    seedTrajectory('t1', { catId: 'opus-46' });
    seedTrajectory('t2', { catId: 'codex' });
    const svc = new TrajectoryQueryService(db);
    const results = svc.listRecent({ catId: 'opus-46', limit: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].catId, 'opus-46');
  });

  it('filters by verified status', () => {
    seedTrajectory('t1', { outputVerified: 1 });
    seedTrajectory('t2', { outputVerified: 0 });
    const svc = new TrajectoryQueryService(db);
    const verified = svc.listRecent({ verified: true, limit: 10 });
    assert.equal(verified.length, 1);
    assert.equal(verified[0].outputVerified, true);
  });

  it('filters by days window', () => {
    const now = Date.now();
    seedTrajectory('t1', { createdAt: now });
    seedTrajectory('t2', { createdAt: now - 8 * 86400000 }); // 8 days ago
    const svc = new TrajectoryQueryService(db);
    const results = svc.listRecent({ days: 7, limit: 10 });
    assert.equal(results.length, 1);
  });

  it('returns parsed JSON fields', () => {
    seedTrajectory('t1', {
      searchEventIds: ['re-001'],
      filesRead: ['foo.ts'],
      filesModified: ['bar.ts'],
      outputVerifiedSignals: ['pr_merged'],
    });
    const svc = new TrajectoryQueryService(db);
    const results = svc.listRecent({ limit: 10 });
    assert.deepEqual(results[0].searchEventIds, ['re-001']);
    assert.deepEqual(results[0].filesRead, ['foo.ts']);
    assert.deepEqual(results[0].filesModified, ['bar.ts']);
    assert.deepEqual(results[0].outputVerifiedSignals, ['pr_merged']);
  });

  it('marks trajectories as verified', () => {
    seedTrajectory('t1');
    const svc = new TrajectoryQueryService(db);
    svc.markVerified('t1', ['pr_merged', 'invocation_succeeded']);
    const results = svc.listRecent({ verified: true, limit: 10 });
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].outputVerifiedSignals, ['pr_merged', 'invocation_succeeded']);
  });

  it('counts unverified trajectories', () => {
    seedTrajectory('t1', { outputVerified: 0 });
    seedTrajectory('t2', { outputVerified: 0 });
    seedTrajectory('t3', { outputVerified: 1 });
    const svc = new TrajectoryQueryService(db);
    assert.equal(svc.countUnverified(30), 2);
  });
});
