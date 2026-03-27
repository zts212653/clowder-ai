import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../../dist/domains/memory/schema.js';

describe('Schema V4: summary_segments + summary_state', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  it('schema version matches CURRENT_SCHEMA_VERSION after migration', () => {
    const { v } = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(v, CURRENT_SCHEMA_VERSION, `schema version should be ${CURRENT_SCHEMA_VERSION}, got ${v}`);
  });

  it('summary_segments table exists with correct columns', () => {
    const columns = db.prepare("PRAGMA table_info('summary_segments')").all();
    const names = columns.map((c) => c.name);
    assert.ok(names.includes('id'));
    assert.ok(names.includes('thread_id'));
    assert.ok(names.includes('level'));
    assert.ok(names.includes('from_message_id'));
    assert.ok(names.includes('to_message_id'));
    assert.ok(names.includes('message_count'));
    assert.ok(names.includes('summary'));
    assert.ok(names.includes('topic_key'));
    assert.ok(names.includes('topic_label'));
    assert.ok(names.includes('boundary_reason'));
    assert.ok(names.includes('boundary_confidence'));
    assert.ok(names.includes('related_segment_ids'));
    assert.ok(names.includes('candidates'));
    assert.ok(names.includes('supersedes_segment_ids'));
    assert.ok(names.includes('model_id'));
    assert.ok(names.includes('prompt_version'));
    assert.ok(names.includes('generated_at'));
  });

  it('summary_state table exists with correct columns', () => {
    const columns = db.prepare("PRAGMA table_info('summary_state')").all();
    const names = columns.map((c) => c.name);
    assert.ok(names.includes('thread_id'));
    assert.ok(names.includes('last_summarized_message_id'));
    assert.ok(names.includes('pending_message_count'));
    assert.ok(names.includes('pending_token_count'));
    assert.ok(names.includes('pending_signal_flags'));
    assert.ok(names.includes('carry_over'));
    assert.ok(names.includes('summary_type'));
    assert.ok(names.includes('last_abstractive_at'));
    assert.ok(names.includes('abstractive_token_count'));
  });

  it('can INSERT a summary_segment', () => {
    db.prepare(`INSERT INTO summary_segments
      (id, thread_id, level, from_message_id, to_message_id, message_count,
       summary, topic_key, topic_label, boundary_reason, boundary_confidence,
       model_id, prompt_version, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'seg-001',
      'thread-abc',
      1,
      'msg-100',
      'msg-120',
      20,
      'Discussed F102 Phase G architecture',
      'f102-phase-g',
      'F102 Phase G Architecture',
      'topic shift at msg-120',
      'high',
      'claude-opus-4-6',
      'g2-thread-abstract-v1',
      new Date().toISOString(),
    );

    const row = db.prepare('SELECT * FROM summary_segments WHERE id = ?').get('seg-001');
    assert.equal(row.thread_id, 'thread-abc');
    assert.equal(row.level, 1);
    assert.equal(row.topic_key, 'f102-phase-g');
    assert.equal(row.message_count, 20);
  });

  it('can INSERT and UPDATE summary_state', () => {
    db.prepare(`INSERT INTO summary_state
      (thread_id, last_summarized_message_id, pending_message_count,
       pending_token_count, pending_signal_flags, summary_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('thread-abc', 'msg-100', 5, 800, 3, 'concat');

    const row = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('thread-abc');
    assert.equal(row.pending_message_count, 5);
    assert.equal(row.pending_token_count, 800);
    assert.equal(row.pending_signal_flags, 3);
    assert.equal(row.summary_type, 'concat');

    // Update after L1 abstractive
    db.prepare(`UPDATE summary_state SET
      pending_message_count = 0, pending_token_count = 0, pending_signal_flags = 0,
      summary_type = 'abstractive', last_abstractive_at = ?, abstractive_token_count = ?
      WHERE thread_id = ?
    `).run(new Date().toISOString(), 350, 'thread-abc');

    const updated = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('thread-abc');
    assert.equal(updated.pending_message_count, 0);
    assert.equal(updated.summary_type, 'abstractive');
    assert.equal(updated.abstractive_token_count, 350);
  });

  it('indexes exist for segments', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='summary_segments'")
      .all();
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes('idx_segments_thread'));
    assert.ok(names.includes('idx_segments_thread_level'));
    assert.ok(names.includes('idx_segments_topic'));
  });

  it('segments with related_segment_ids and candidates as JSON', () => {
    const relatedIds = JSON.stringify(['seg-prev-001', 'seg-prev-002']);
    const candidates = JSON.stringify([{ kind: 'decision', title: 'Use Opus for summaries' }]);

    db.prepare(`INSERT INTO summary_segments
      (id, thread_id, level, from_message_id, to_message_id, message_count,
       summary, topic_key, topic_label, related_segment_ids, candidates,
       model_id, prompt_version, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'seg-002',
      'thread-abc',
      1,
      'msg-121',
      'msg-140',
      19,
      'Decided on Opus 4.6 for abstractive summaries',
      'f102-phase-g',
      'Summary Model Decision',
      relatedIds,
      candidates,
      'claude-opus-4-6',
      'g2-thread-abstract-v1',
      new Date().toISOString(),
    );

    const row = db.prepare('SELECT * FROM summary_segments WHERE id = ?').get('seg-002');
    assert.deepEqual(JSON.parse(row.related_segment_ids), ['seg-prev-001', 'seg-prev-002']);
    assert.deepEqual(JSON.parse(row.candidates), [{ kind: 'decision', title: 'Use Opus for summaries' }]);
  });

  it('V4 migration is idempotent on existing V3 DB', () => {
    const db2 = new Database(':memory:');
    // Simulate V3 DB
    applyMigrations(db2);
    // Re-run should not throw
    applyMigrations(db2);
    const { v } = db2.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(v, CURRENT_SCHEMA_VERSION, `schema version should be ${CURRENT_SCHEMA_VERSION}, got ${v}`);
  });
});
