import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

describe('TaskOutcomeEpisodeStore (F192 Phase G)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
  });

  it('creates an episode and retrieves it', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    assert.ok(ep.episodeId.startsWith('ep-'));
    assert.equal(ep.trigger, 'user_ask');
    assert.equal(ep.threadId, 'thread_abc');
    assert.equal(ep.attribution, 'unmanaged_not_applicable');
    assert.equal(ep.workId, null);
    assert.equal(ep.attemptId, null);
    assert.equal(ep.terminalState, 'in_progress');
    assert.equal(ep.verdict, null);

    const found = store.getEpisode(ep.episodeId);
    assert.deepEqual(found, ep);
  });

  it('returns null for non-existent episode', () => {
    assert.equal(store.getEpisode('ep-nonexistent'), null);
  });

  it('appends a permission cancel signal to an episode', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'permission_cancel',
        toolName: 'cat_cafe_hold_ball',
        reason: 'wrong_direction',
        timestamp: new Date().toISOString(),
        catId: 'opus',
        threadId: 'thread_abc',
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'a2');
    assert.equal(signals[0].record.type, 'permission_cancel');
  });

  it('appends a magic word signal to an episode', () => {
    const ep = store.createEpisode({
      trigger: 'task_created',
      threadId: 'thread_xyz',
      participants: ['codex'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word',
        word: '脚手架',
        timestamp: new Date().toISOString(),
        threadId: 'thread_xyz',
        catId: 'codex',
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].record.type, 'magic_word');
  });

  it('appends an A1 world truth signal', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a1',
      record: {
        type: 'merge',
        ref: 'PR#2073',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'a1');
    assert.equal(signals[0].record.type, 'merge');
  });

  it('updates terminal state', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.updateTerminalState(ep.episodeId, 'completed');
    const updated = store.getEpisode(ep.episodeId);
    assert.equal(updated?.terminalState, 'completed');
  });

  it('updates verdict', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.updateVerdict(ep.episodeId, 'corrected_success');
    const updated = store.getEpisode(ep.episodeId);
    assert.equal(updated?.verdict, 'corrected_success');
  });

  it('lists episodes by threadId', () => {
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['codex'] });
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_b', participants: ['opus'] });

    const threadA = store.listByThread('thread_a');
    assert.equal(threadA.length, 2);

    const threadB = store.listByThread('thread_b');
    assert.equal(threadB.length, 1);
  });

  it('lists episodes that need verdict (null verdict + completed)', () => {
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep1.episodeId, 'completed');

    const ep2 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep2.episodeId, 'completed');
    store.updateVerdict(ep2.episodeId, 'success');

    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_b', participants: ['opus'] });
    // still in_progress — not ready for verdict

    const needsVerdict = store.listNeedingVerdict();
    assert.equal(needsVerdict.length, 1);
    assert.equal(needsVerdict[0].episodeId, ep1.episodeId);
  });

  it('getActiveEpisode returns an in_progress episode for a thread', () => {
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep1.episodeId, 'completed');
    const ep2 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });

    const active = store.getActiveEpisode('thread_a');
    assert.equal(active?.episodeId, ep2.episodeId);
  });

  it('getActiveEpisode returns null when no in_progress episode', () => {
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep.episodeId, 'completed');
    assert.equal(store.getActiveEpisode('thread_a'), null);
  });

  it('selects active episodes by explicit attribution instead of thread recency', () => {
    const threadId = 'thread_shared';
    const unmanaged = store.createEpisode({ trigger: 'user_ask', threadId, participants: ['opus'] });
    const workA = store.createEpisode({
      trigger: 'task_created',
      threadId,
      participants: ['codex-sol'],
      attribution: 'managed_attributed',
      workId: 'wrk_a',
      attemptId: 'wat_a_1',
    });
    const workB = store.createEpisode({
      trigger: 'task_created',
      threadId,
      participants: ['codex-terra'],
      attribution: 'managed_attributed',
      workId: 'wrk_b',
      attemptId: 'wat_b_1',
    });
    const unattributed = store.createEpisode({
      trigger: 'task_created',
      threadId,
      participants: [],
      artifacts: ['pr:owner/repo#42'],
      attribution: 'managed_unattributed',
    });

    assert.equal(
      store.getActiveEpisodeByAttribution({
        attribution: 'managed_attributed',
        workId: 'wrk_a',
        attemptId: 'wat_a_1',
      })?.episodeId,
      workA.episodeId,
    );
    assert.equal(
      store.getActiveEpisodeByAttribution({
        attribution: 'managed_attributed',
        workId: 'wrk_b',
        attemptId: 'wat_b_1',
      })?.episodeId,
      workB.episodeId,
    );
    assert.equal(
      store.getActiveEpisodeByAttribution({ attribution: 'unmanaged_not_applicable', threadId })?.episodeId,
      unmanaged.episodeId,
    );
    assert.equal(
      store.getActiveEpisodeByAttribution({
        attribution: 'managed_unattributed',
        artifactRef: 'pr:owner/repo#42',
      })?.episodeId,
      unattributed.episodeId,
    );
  });

  // ---- Idempotency guard (F192 Day-24 verdict fix) ----

  it('appendSignal with same idempotencyKey on same episode inserts only once', () => {
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    const input = {
      category: /** @type {const} */ ('a2'),
      record: { type: 'magic_word_ref', eventId: 'evt_abc', word: '下次一定', threadId: 'thread_a', catId: 'opus' },
      idempotencyKey: 'mwr:evt_abc',
    };

    const r1 = store.appendSignal(ep.episodeId, input);
    assert.equal(r1.appended, true);

    const r2 = store.appendSignal(ep.episodeId, input);
    assert.equal(r2.appended, false);

    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1, 'duplicate signal should be silently deduped');
  });

  it('appendSignal with same idempotencyKey on different episodes inserts both', () => {
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    const ep2 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_b', participants: ['opus'] });
    const key = 'mwr:evt_shared';
    const input = {
      category: /** @type {const} */ ('a2'),
      record: { type: 'magic_word_ref', eventId: 'evt_shared', word: '脚手架', threadId: 'thread_a', catId: 'opus' },
      idempotencyKey: key,
    };

    store.appendSignal(ep1.episodeId, input);
    store.appendSignal(ep2.episodeId, { ...input, record: { ...input.record, threadId: 'thread_b' } });

    assert.equal(store.getSignals(ep1.episodeId).length, 1);
    assert.equal(store.getSignals(ep2.episodeId).length, 1);
  });

  it('appendSignal without idempotencyKey allows duplicates (backward compat)', () => {
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    const input = {
      category: /** @type {const} */ ('a1'),
      record: { type: 'merge', ref: 'PR#100', outcome: 'success', timestamp: new Date().toISOString() },
    };

    store.appendSignal(ep.episodeId, input);
    store.appendSignal(ep.episodeId, input);

    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 2, 'no idempotencyKey = no dedup (backward compat)');
  });

  it('hasSignalByIdempotencyKey returns true across episodes', () => {
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    const key = 'mwr:evt_global';

    assert.equal(store.hasSignalByIdempotencyKey(key), false, 'before insert');

    store.appendSignal(ep.episodeId, {
      category: /** @type {const} */ ('a2'),
      record: { type: 'magic_word_ref', eventId: 'evt_global' },
      idempotencyKey: key,
    });

    assert.equal(store.hasSignalByIdempotencyKey(key), true, 'after insert');

    // Still true even if we complete the episode and ask from a different context
    store.updateTerminalState(ep.episodeId, 'completed');
    assert.equal(store.hasSignalByIdempotencyKey(key), true, 'after episode completed');
  });

  // ---- Migration backfill (cloud review P1 — pre-upgrade replay gap) ----

  it('migration backfills idempotencyKey for pre-existing magic_word_ref signals', () => {
    // Simulate a pre-v2 database: old schema WITHOUT idempotencyKey column
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-backfill-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');

    const rawDb = new Database(dbPath);
    rawDb.pragma('journal_mode = WAL');
    rawDb.exec(`
      CREATE TABLE task_outcome_episodes (
        episodeId TEXT PRIMARY KEY, trigger_type TEXT NOT NULL,
        threadId TEXT NOT NULL, participants TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        terminalState TEXT NOT NULL DEFAULT 'in_progress',
        verdict TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE task_outcome_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episodeId TEXT NOT NULL REFERENCES task_outcome_episodes(episodeId),
        category TEXT NOT NULL, record TEXT NOT NULL, createdAt TEXT NOT NULL
      );
    `);

    // Insert episode + pre-existing magic_word_ref (no idempotencyKey column)
    rawDb
      .prepare(
        `INSERT INTO task_outcome_episodes (episodeId, trigger_type, threadId, participants, createdAt)
       VALUES ('ep-old', 'cat_initiated', 'thread_old', '["opus"]', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    rawDb
      .prepare(
        `INSERT INTO task_outcome_signals (episodeId, category, record, createdAt)
       VALUES ('ep-old', 'a2', '{"type":"magic_word_ref","eventId":"evt_pre","word":"脚手架"}', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    rawDb
      .prepare(
        `INSERT INTO task_outcome_episodes (episodeId, trigger_type, threadId, participants, createdAt)
       VALUES ('ep-old-pr', 'cat_initiated', 'thread_old', '[]', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    rawDb
      .prepare(
        `INSERT INTO task_outcome_signals (episodeId, category, record, createdAt)
       VALUES ('ep-old-pr', 'a1', '{"type":"merge","ref":"PR#1","outcome":"success"}', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    rawDb.close();

    // Open via TaskOutcomeEpisodeStore — migration backfills idempotencyKey
    const migratedStore = new TaskOutcomeEpisodeStore(dbPath);

    assert.deepEqual(
      {
        attribution: migratedStore.getEpisode('ep-old')?.attribution,
        workId: migratedStore.getEpisode('ep-old')?.workId,
        attemptId: migratedStore.getEpisode('ep-old')?.attemptId,
      },
      { attribution: 'unmanaged_not_applicable', workId: null, attemptId: null },
      'pre-F275 rows must migrate into the non-managed bucket',
    );
    assert.equal(
      migratedStore.getEpisode('ep-old-pr')?.attribution,
      'managed_unattributed',
      'legacy PR evidence is a coverage defect, not ordinary conversation',
    );

    // Pre-existing signal should now be discoverable by hasSignalByIdempotencyKey
    assert.equal(
      migratedStore.hasSignalByIdempotencyKey('mwr:evt_pre'),
      true,
      'backfill should make pre-existing magic_word_ref discoverable',
    );

    // Same-episode replay should be deduped by the backfilled key
    const result = migratedStore.appendSignal('ep-old', {
      category: /** @type {const} */ ('a2'),
      record: { type: 'magic_word_ref', eventId: 'evt_pre' },
      idempotencyKey: 'mwr:evt_pre',
    });
    assert.equal(result.appended, false, 'replay of backfilled eventId should be deduped');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not reclassify post-migration unmanaged PR evidence on restart', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-attribution-restart-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const firstStore = new TaskOutcomeEpisodeStore(dbPath);
    const episode = firstStore.createEpisode({
      trigger: 'cat_initiated',
      threadId: 'thread_unmanaged',
      participants: [],
      attribution: 'unmanaged_not_applicable',
    });
    firstStore.appendSignal(episode.episodeId, {
      category: /** @type {const} */ ('a1'),
      record: { type: 'merge', ref: 'manual:PR#1', outcome: 'success' },
    });

    const restartedStore = new TaskOutcomeEpisodeStore(dbPath);

    assert.equal(
      restartedStore.getEpisode(episode.episodeId)?.attribution,
      'unmanaged_not_applicable',
      'the legacy backfill must not rerun against episodes created after the schema migration',
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migration backfill is idempotent across restarts with pre-existing duplicates', () => {
    // Pre-v2 DB with DUPLICATE magic_word_ref rows in same episode (the exact
    // scenario this PR prevents going forward, but may exist in historical data)
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'store-restart-'));
    const dbPath2 = path.join(tmpDir2, 'test.sqlite');

    const rawDb = new Database(dbPath2);
    rawDb.pragma('journal_mode = WAL');
    rawDb.exec(`
      CREATE TABLE task_outcome_episodes (
        episodeId TEXT PRIMARY KEY, trigger_type TEXT NOT NULL,
        threadId TEXT NOT NULL, participants TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        terminalState TEXT NOT NULL DEFAULT 'in_progress',
        verdict TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE task_outcome_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        episodeId TEXT NOT NULL, category TEXT NOT NULL,
        record TEXT NOT NULL, createdAt TEXT NOT NULL
      );
    `);
    rawDb
      .prepare(
        `INSERT INTO task_outcome_episodes (episodeId, trigger_type, threadId, participants, createdAt)
       VALUES ('ep-dup', 'cat_initiated', 'thread_dup', '["opus"]', '2026-07-01T00:00:00.000Z')`,
      )
      .run();
    // Two duplicate rows: same eventId, same episode
    for (const ts of ['00:00:01', '00:00:02']) {
      rawDb
        .prepare(
          `INSERT INTO task_outcome_signals (episodeId, category, record, createdAt)
         VALUES ('ep-dup', 'a2', '{"type":"magic_word_ref","eventId":"evt_dup","word":"脚手架"}',
                 '2026-07-01T${ts}.000Z')`,
        )
        .run();
    }
    rawDb.close();

    // First startup — backfill + index creation
    const s1 = new TaskOutcomeEpisodeStore(dbPath2);
    assert.equal(s1.hasSignalByIdempotencyKey('mwr:evt_dup'), true);

    // Second startup — must NOT throw (UPDATE OR IGNORE makes it idempotent)
    assert.doesNotThrow(() => new TaskOutcomeEpisodeStore(dbPath2));

    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});
