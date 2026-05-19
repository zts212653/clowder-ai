import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F200 Phase D — trajectory persistence via correlation hook', () => {
  let Database, applyMigrations, SCHEMA_V1, triggerRecallCorrelation;
  let db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import(`../../dist/domains/memory/schema.js?v=${Date.now()}`);
    applyMigrations = schema.applyMigrations;
    SCHEMA_V1 = schema.SCHEMA_V1;
    const hook = await import(`../../dist/domains/memory/recall-correlation-hook.js?v=${Date.now()}`);
    triggerRecallCorrelation = hook.triggerRecallCorrelation;

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    applyMigrations(db);
  });

  function makeSearchThenReadEvents(invocationId, catId) {
    const base = Date.now();
    return [
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-100',
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
              targetRef: { kind: 'doc', sourcePath: 'docs/features/F200-memory-recall-eval.md' },
              docKind: 'feature',
            },
          ],
        },
      },
      {
        invocationId,
        sessionId: 's1',
        threadId: 'thread-100',
        catId,
        toolName: 'Read',
        timestamp: base + 3000,
        turnIndex: 1,
        status: 'ok',
        summary: { file_path: 'docs/features/F200-memory-recall-eval.md' },
      },
    ];
  }

  it('HW-4 根因②c: command_execution shell-read feeds files_read_json', async () => {
    const base = Date.now();
    const events = [
      {
        invocationId: 'inv-sc',
        sessionId: 's1',
        threadId: 'thread-sc',
        catId: 'codex',
        toolName: 'search_evidence',
        timestamp: base,
        turnIndex: 0,
        status: 'ok',
        summary: {
          _f200Candidates: [
            { anchor: 'F200', rank: 0, sourcePath: 'docs/features/F200-memory-recall-eval.md', docKind: 'feature' },
          ],
        },
      },
      {
        invocationId: 'inv-sc',
        sessionId: 's1',
        threadId: 'thread-sc',
        catId: 'codex',
        toolName: 'command_execution',
        timestamp: base + 3000,
        turnIndex: 1,
        status: 'ok',
        summary: { command: `/bin/zsh -lc "sed -n '1,260p' docs/features/F200-memory-recall-eval.md"` },
      },
    ];
    await triggerRecallCorrelation(db, events, 'inv-sc', 'codex');
    const t = db.prepare('SELECT * FROM task_trajectories WHERE invocation_id = ?').get('inv-sc');
    assert.ok(t, 'trajectory created');
    const filesRead = JSON.parse(t.files_read_json);
    assert.ok(
      filesRead.includes('docs/features/F200-memory-recall-eval.md'),
      `shell-read path must feed files_read_json, got ${JSON.stringify(filesRead)}`,
    );
  });

  it('creates a task_trajectories record after correlation', async () => {
    const events = makeSearchThenReadEvents('inv-100', 'opus-46');
    await triggerRecallCorrelation(db, events, 'inv-100', 'opus-46');

    const trajectories = db.prepare('SELECT * FROM task_trajectories WHERE invocation_id = ?').all('inv-100');
    assert.equal(trajectories.length, 1, 'should create exactly one trajectory');

    const t = trajectories[0];
    assert.equal(t.invocation_id, 'inv-100');
    assert.equal(t.thread_id, 'thread-100');
    assert.equal(t.cat_id, 'opus-46');
    assert.equal(t.output_verified, 0);

    const eventIds = JSON.parse(t.search_event_ids_json);
    assert.ok(eventIds.length > 0, 'should have at least one recall event id');

    const filesRead = JSON.parse(t.files_read_json);
    assert.ok(filesRead.includes('docs/features/F200-memory-recall-eval.md'));
  });

  it('does not create trajectory for non-memory invocations', async () => {
    const events = [
      {
        invocationId: 'inv-200',
        sessionId: 's1',
        threadId: 'thread-200',
        catId: 'opus-46',
        toolName: 'Read',
        timestamp: Date.now(),
        turnIndex: 0,
        status: 'ok',
        summary: { file_path: 'src/foo.ts' },
      },
    ];
    await triggerRecallCorrelation(db, events, 'inv-200', 'opus-46');

    const trajectories = db.prepare('SELECT * FROM task_trajectories WHERE invocation_id = ?').all('inv-200');
    assert.equal(trajectories.length, 0, 'no trajectory for non-memory invocation');
  });
});
