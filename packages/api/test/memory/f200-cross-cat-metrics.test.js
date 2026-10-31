import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — Cross-Cat Metrics', () => {
  let Database, applyMigrations, SCHEMA_V1, CrossCatMetricsComputer;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const mod = await import(`../../dist/domains/memory/CrossCatMetricsComputer.js?v=${Date.now()}`);
    CrossCatMetricsComputer = mod.CrossCatMetricsComputer;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function seedTrajectory(id, catId, opts = {}) {
    const now = Date.now();
    const params = [
      id,
      `inv-${id}`,
      opts.threadId ?? 'thread-001',
      catId,
      opts.taskContext ?? 'test query',
      JSON.stringify(opts.searchEventIds ?? ['re-1', 're-2']),
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

  function seedRecallEvents(invocationId, count) {
    for (let i = 0; i < count; i++) {
      db.prepare(`
        INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
          candidates_json, consumed_json, reformulated, fell_back_to_grep, abandoned,
          next_graph_resolve_after_read, token_cost, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `re-${invocationId}-${i}`,
        'opus-46',
        invocationId,
        'search_evidence',
        'test',
        'hybrid',
        'docs',
        '[]',
        i === 0 ? '[{"anchor":"a","rank":0,"method":"Read"}]' : '[]',
        i > 0 ? 1 : 0,
        0,
        0,
        0,
        100,
        Date.now(),
      );
    }
  }

  it('computes crossCatReformulationSpread across cats', () => {
    seedTrajectory('t1', 'opus-46', { searchEventIds: ['re-inv-t1-0', 're-inv-t1-1'] });
    seedTrajectory('t2', 'codex', { searchEventIds: ['re-inv-t2-0', 're-inv-t2-1', 're-inv-t2-2'] });
    seedRecallEvents('inv-t1', 2);
    seedRecallEvents('inv-t2', 3);

    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);

    assert.equal(typeof metrics.crossCatReformulationSpread, 'number');
    assert.ok(metrics.crossCatReformulationSpread >= 0);
  });

  it('computes unverifiedConsumptionRate', () => {
    seedTrajectory('t1', 'opus-46', { outputVerified: 0, searchEventIds: ['re-inv-t1-0'] });
    seedTrajectory('t2', 'opus-46', { outputVerified: 1, searchEventIds: ['re-inv-t2-0'] });
    seedTrajectory('t3', 'opus-46', { outputVerified: 0, searchEventIds: [] });
    seedRecallEvents('inv-t1', 1); // has consumed
    seedRecallEvents('inv-t2', 1); // has consumed but verified
    // t3 has no recall events — no consumed

    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);

    assert.equal(typeof metrics.unverifiedConsumptionRate, 'number');
    assert.ok(metrics.unverifiedConsumptionRate >= 0);
    assert.ok(metrics.unverifiedConsumptionRate <= 1);
  });

  it('returns trajectory and verified counts', () => {
    seedTrajectory('t1', 'opus-46', { outputVerified: 1 });
    seedTrajectory('t2', 'codex', { outputVerified: 0 });
    seedTrajectory('t3', 'codex', { outputVerified: 1 });

    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);

    assert.equal(metrics.trajectoryCount, 3);
    assert.equal(metrics.verifiedCount, 2);
  });

  it('handles empty data gracefully', () => {
    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);
    assert.equal(metrics.trajectoryCount, 0);
    assert.equal(metrics.crossCatReformulationSpread, 0);
    assert.equal(metrics.unverifiedConsumptionRate, 0);
  });
});
