import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — TrajectoryAggregator', () => {
  let Database, applyMigrations, SCHEMA_V1, TrajectoryAggregator;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const mod = await import(`../../dist/domains/memory/TrajectoryAggregator.js?v=${Date.now()}`);
    TrajectoryAggregator = mod.TrajectoryAggregator;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function seedRecallEvents(invocationId, catId) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
        candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
        next_graph_resolve_after_read, token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      're-001',
      catId,
      invocationId,
      'search_evidence',
      'F200 rerank',
      'hybrid',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      800,
      now,
    );
    db.prepare(`
      INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
        candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
        next_graph_resolve_after_read, token_cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      're-002',
      catId,
      invocationId,
      'graph_resolve',
      'consumption prior',
      'lexical',
      'docs',
      '[]',
      '[]',
      0,
      0,
      0,
      0,
      500,
      now + 5000,
    );
  }

  function makeEvents(invocationId, catId) {
    const base = Date.now();
    return [
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'search_evidence',
        timestamp: base,
        turnIndex: 0,
        status: 'ok',
        summary: {},
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'Read',
        timestamp: base + 2000,
        turnIndex: 1,
        status: 'ok',
        summary: { file_path: 'src/memory/foo.ts' },
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'graph_resolve',
        timestamp: base + 5000,
        turnIndex: 2,
        status: 'ok',
        summary: {},
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'Read',
        timestamp: base + 7000,
        turnIndex: 3,
        status: 'ok',
        summary: { file_path: 'src/memory/bar.ts' },
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'Edit',
        timestamp: base + 10000,
        turnIndex: 4,
        status: 'ok',
        summary: { file_path: 'src/memory/bar.ts' },
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-001',
        catId,
        toolName: 'Write',
        timestamp: base + 12000,
        turnIndex: 5,
        status: 'ok',
        summary: { file_path: 'src/memory/new.ts' },
      },
    ];
  }

  it('aggregates RecallEvents into a trajectory', () => {
    const invId = 'inv-001';
    const catId = 'opus-46';
    seedRecallEvents(invId, catId);
    const events = makeEvents(invId, catId);

    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate(invId, 'thread-001', catId, events);

    assert.ok(traj, 'trajectory should not be null');
    assert.equal(traj.invocationId, invId);
    assert.equal(traj.threadId, 'thread-001');
    assert.equal(traj.catId, catId);
    assert.deepEqual(traj.searchEventIds, ['re-001', 're-002']);
  });

  it('extracts filesRead from Read events', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    assert.deepEqual(traj.filesRead, ['src/memory/foo.ts', 'src/memory/bar.ts']);
  });

  it('extracts filesModified from Edit/Write events', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    assert.deepEqual(traj.filesModified, ['src/memory/bar.ts', 'src/memory/new.ts']);
  });

  it('computes totalTokenCost from recall events', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    assert.equal(traj.totalTokenCost, 1300); // 800 + 500
  });

  it('computes duration from first to last event', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    assert.equal(traj.duration, 12000); // last ts - first ts
  });

  it('infers taskContext from deduplicated search queries', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    assert.equal(traj.taskContext, 'F200 rerank → consumption prior');
  });

  it('returns null for invocations with no recall events', () => {
    const events = makeEvents('inv-999', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-999', 'thread-001', 'opus-46', events);
    assert.equal(traj, null);
  });

  it('persists trajectory to sqlite', () => {
    seedRecallEvents('inv-001', 'opus-46');
    const events = makeEvents('inv-001', 'opus-46');
    const agg = new TrajectoryAggregator(db);
    const traj = agg.aggregate('inv-001', 'thread-001', 'opus-46', events);
    agg.persist(traj);

    const row = db.prepare('SELECT * FROM task_trajectories WHERE invocation_id = ?').get('inv-001');
    assert.ok(row, 'trajectory row should exist');
    assert.equal(row.cat_id, 'opus-46');
    assert.equal(row.thread_id, 'thread-001');
    assert.deepEqual(JSON.parse(row.search_event_ids_json), ['re-001', 're-002']);
    assert.deepEqual(JSON.parse(row.files_read_json), ['src/memory/foo.ts', 'src/memory/bar.ts']);
    assert.equal(row.output_verified, 0);
  });
});
