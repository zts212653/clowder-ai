import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — end-to-end integration', () => {
  let Database, applyMigrations, SCHEMA_V1;
  let triggerRecallCorrelation, TrajectoryQueryService, CrossCatMetricsComputer, OutputVerifiedDetector;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const hook = await import(`../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`);
    triggerRecallCorrelation = hook.triggerRecallCorrelation;
    const tqs = await import(`../../dist/domains/memory/TrajectoryQueryService.js?v=${Date.now()}`);
    TrajectoryQueryService = tqs.TrajectoryQueryService;
    const ccm = await import(`../../dist/domains/memory/CrossCatMetricsComputer.js?v=${Date.now()}`);
    CrossCatMetricsComputer = ccm.CrossCatMetricsComputer;
    const ovd = await import(`../../dist/domains/memory/output-verified-detector.js?v=${Date.now()}`);
    OutputVerifiedDetector = ovd.OutputVerifiedDetector;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function makeMemoryEvents(invocationId, catId, threadId, opts = {}) {
    const base = Date.now();
    const events = [
      {
        invocationId,
        sessionId: 's1',
        threadId,
        catId,
        toolName: 'search_evidence',
        timestamp: base,
        turnIndex: 0,
        status: 'ok',
        summary: {
          _f200Candidates: [
            {
              anchor: 'doc:features/F200',
              rank: 0,
              targetRef: { kind: 'doc', sourcePath: 'docs/features/F200.md' },
              docKind: 'feature',
            },
          ],
        },
      },
      {
        invocationId,
        sessionId: 's1',
        threadId,
        catId,
        toolName: 'Read',
        timestamp: base + 2000,
        turnIndex: 1,
        status: 'ok',
        summary: { file_path: 'docs/features/F200.md' },
      },
    ];
    if (opts.extraSearch) {
      events.push({
        invocationId,
        sessionId: 's1',
        threadId,
        catId,
        toolName: 'search_evidence',
        timestamp: base + 5000,
        turnIndex: 2,
        status: 'ok',
        summary: {
          _f200Candidates: [
            {
              anchor: 'doc:lessons',
              rank: 0,
              targetRef: { kind: 'doc', sourcePath: 'docs/lessons.md' },
              docKind: 'lesson',
            },
          ],
        },
      });
    }
    if (opts.edit) {
      events.push({
        invocationId,
        sessionId: 's1',
        threadId,
        catId,
        toolName: 'Edit',
        timestamp: base + 8000,
        turnIndex: 3,
        status: 'ok',
        summary: { file_path: opts.edit },
      });
    }
    return events;
  }

  it('full pipeline: correlation → trajectory → query → cross-cat metrics', async () => {
    await triggerRecallCorrelation(db, makeMemoryEvents('inv-a', 'opus-46', 'thread-1'), 'inv-a', 'opus-46');
    await triggerRecallCorrelation(
      db,
      makeMemoryEvents('inv-b', 'codex', 'thread-2', { extraSearch: true }),
      'inv-b',
      'codex',
    );
    await triggerRecallCorrelation(
      db,
      makeMemoryEvents('inv-c', 'opus-46', 'thread-3', { edit: 'src/foo.ts' }),
      'inv-c',
      'opus-46',
    );

    const svc = new TrajectoryQueryService(db);
    const all = svc.listRecent({ limit: 50 });
    assert.equal(all.length, 3, 'three trajectories created');

    const opusOnly = svc.listRecent({ catId: 'opus-46', limit: 50 });
    assert.equal(opusOnly.length, 2);

    const codexOnly = svc.listRecent({ catId: 'codex', limit: 50 });
    assert.equal(codexOnly.length, 1);
    assert.deepEqual(codexOnly[0].filesRead, ['docs/features/F200.md']);

    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);
    assert.equal(metrics.trajectoryCount, 3);
    assert.equal(metrics.verifiedCount, 0);
    assert.ok(metrics.crossCatReformulationSpread >= 0);
  });

  it('markVerified updates trajectory and cross-cat verified count', async () => {
    await triggerRecallCorrelation(db, makeMemoryEvents('inv-x', 'opus-46', 'thread-10'), 'inv-x', 'opus-46');

    const svc = new TrajectoryQueryService(db);
    const before = svc.listRecent({ limit: 10 });
    assert.equal(before[0].outputVerified, false);

    svc.markVerified(before[0].trajectoryId, ['pr_merged', 'invocation_succeeded']);

    const after = svc.listRecent({ verified: true, limit: 10 });
    assert.equal(after.length, 1);
    assert.deepEqual(after[0].outputVerifiedSignals, ['pr_merged', 'invocation_succeeded']);

    const computer = new CrossCatMetricsComputer(db);
    const metrics = computer.compute(30);
    assert.equal(metrics.verifiedCount, 1);
  });

  it('OutputVerifiedDetector integrates with injectable signal sources', async () => {
    const sources = {
      getInvocationStatus: async (invId) => (invId === 'inv-ok' ? 'completed' : 'failed'),
      isPrMergedForThread: async (threadId) => threadId === 'thread-merged',
    };
    const detector = new OutputVerifiedDetector(sources);

    const r1 = await detector.detect('inv-ok', 'thread-merged');
    assert.equal(r1.verified, true);
    assert.ok(r1.signals.includes('pr_merged'));

    const r2 = await detector.detect('inv-ok', 'thread-nope');
    assert.equal(r2.verified, false);

    const r3 = await detector.detect('inv-fail', 'thread-merged');
    assert.equal(r3.verified, true, 'pr_merged alone is sufficient');
  });

  it('countUnverified reflects pipeline state accurately', async () => {
    await triggerRecallCorrelation(db, makeMemoryEvents('inv-1', 'opus-46', 'th-1'), 'inv-1', 'opus-46');
    await triggerRecallCorrelation(db, makeMemoryEvents('inv-2', 'codex', 'th-2'), 'inv-2', 'codex');
    await triggerRecallCorrelation(db, makeMemoryEvents('inv-3', 'opus-46', 'th-3'), 'inv-3', 'opus-46');

    const svc = new TrajectoryQueryService(db);
    assert.equal(svc.countUnverified(30), 3);

    const all = svc.listRecent({ limit: 50 });
    svc.markVerified(all[0].trajectoryId, ['pr_merged']);
    assert.equal(svc.countUnverified(30), 2);
  });

  it('filesModified captured from Edit events in trajectory', async () => {
    await triggerRecallCorrelation(
      db,
      makeMemoryEvents('inv-edit', 'opus-46', 'th-edit', { edit: 'packages/api/src/routes/foo.ts' }),
      'inv-edit',
      'opus-46',
    );

    const svc = new TrajectoryQueryService(db);
    const trajectories = svc.listRecent({ limit: 10 });
    assert.equal(trajectories.length, 1);
    assert.ok(trajectories[0].filesModified.includes('packages/api/src/routes/foo.ts'));
  });

  it('listRecent with oldestFirst returns trajectories in ascending order', async () => {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO task_trajectories
        (trajectory_id, invocation_id, thread_id, cat_id, task_context,
         search_event_ids_json, files_read_json, files_modified_json,
         output_verified, output_verified_signals_json,
         total_token_cost, duration, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', 0, '[]', 0, 0, ?, ?)
    `);
    insert.run('tid-old', 'inv-old', 'th-old', 'opus-46', 'old task', now - 3000, now - 3000);
    insert.run('tid-mid', 'inv-mid', 'th-mid', 'opus-46', 'mid task', now - 2000, now - 2000);
    insert.run('tid-new', 'inv-new', 'th-new', 'opus-46', 'new task', now - 1000, now - 1000);

    const svc = new TrajectoryQueryService(db);

    const descResults = svc.listRecent({ limit: 2 });
    assert.equal(descResults.length, 2);
    assert.equal(descResults[0].invocationId, 'inv-new', 'default DESC returns newest first');

    const ascResults = svc.listRecent({ limit: 2, oldestFirst: true });
    assert.equal(ascResults.length, 2);
    assert.equal(ascResults[0].invocationId, 'inv-old', 'oldestFirst returns oldest first');
    assert.equal(ascResults[1].invocationId, 'inv-mid', 'oldestFirst second item is middle');
  });

  it('trajectory captures files from events using path key (not just file_path)', async () => {
    const base = Date.now();
    const events = [
      {
        invocationId: 'inv-path',
        sessionId: 's1',
        threadId: 'th-path',
        catId: 'opus-46',
        toolName: 'search_evidence',
        timestamp: base,
        turnIndex: 0,
        status: 'ok',
        summary: {
          _f200Candidates: [
            { anchor: 'doc:test', rank: 0, targetRef: { kind: 'doc', sourcePath: 'test.md' }, docKind: 'doc' },
          ],
        },
      },
      {
        invocationId: 'inv-path',
        sessionId: 's1',
        threadId: 'th-path',
        catId: 'opus-46',
        toolName: 'Read',
        timestamp: base + 1000,
        turnIndex: 1,
        status: 'ok',
        summary: { path: 'src/utils/helper.ts' },
      },
      {
        invocationId: 'inv-path',
        sessionId: 's1',
        threadId: 'th-path',
        catId: 'opus-46',
        toolName: 'Write',
        timestamp: base + 2000,
        turnIndex: 2,
        status: 'ok',
        summary: { path: 'src/utils/new-file.ts' },
      },
    ];
    await triggerRecallCorrelation(db, events, 'inv-path', 'opus-46');

    const svc = new TrajectoryQueryService(db);
    const trajectories = svc.listRecent({ limit: 10 });
    assert.equal(trajectories.length, 1);
    assert.ok(trajectories[0].filesRead.includes('src/utils/helper.ts'), 'Read with path key captured');
    assert.ok(trajectories[0].filesModified.includes('src/utils/new-file.ts'), 'Write with path key captured');
  });
});
