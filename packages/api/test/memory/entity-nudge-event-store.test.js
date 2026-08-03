/**
 * F260 PR-5 T2: entity_nudge_events table + store.
 *
 * AC-B5: Five-bucket outcome tracking (followed / conscious_ignore /
 * false_positive / context_suppressed / recurrence_caught) with
 * source_family / alias_class dimensions.
 *
 * Also serves as the persistence layer for cooldown — replaces the
 * in-memory singleton with a durable (entity, thread, rendered_at) query.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('EntityNudgeEventStore', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {typeof import('../../dist/domains/memory/EntityNudgeEventStore.js').EntityNudgeEventStore} */
  let EntityNudgeEventStore;
  /** @type {import('../../dist/domains/memory/EntityNudgeEventStore.js').EntityNudgeEventStore} */
  let store;

  beforeEach(async () => {
    db = new Database(':memory:');
    ({ EntityNudgeEventStore } = await import('../../dist/domains/memory/EntityNudgeEventStore.js'));
    // Assume the store creates/migrates its own table
    store = new EntityNudgeEventStore(db);
  });

  afterEach(() => {
    if (db?.open) db.close();
  });

  // ── Schema ──

  it('creates entity_nudge_events table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_nudge_events'").all();
    assert.equal(tables.length, 1, 'table should exist');
  });

  it('table has required columns', () => {
    const cols = db.prepare('PRAGMA table_info(entity_nudge_events)').all();
    const colNames = cols.map((c) => c.name);
    for (const expected of [
      'event_id',
      'thread_id',
      'invocation_id',
      'cat_id',
      'entity_id',
      'alias_matched',
      'source_family',
      'alias_class',
      'outcome',
      'rendered_at',
      'outcome_at',
    ]) {
      assert.ok(colNames.includes(expected), `missing column: ${expected}`);
    }
  });

  // ── Recording events ──

  it('records a delivered nudge event and returns the event_id', () => {
    const eventId = store.recordDelivered({
      threadId: 'thread_abc',
      invocationId: 'inv-1',
      catId: 'opus',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000000000,
    });
    assert.ok(eventId, 'should return an event_id');
    assert.equal(typeof eventId, 'string');

    const row = db.prepare('SELECT * FROM entity_nudge_events WHERE event_id = ?').get(eventId);
    assert.equal(row.thread_id, 'thread_abc');
    assert.equal(row.entity_id, 'concept:未婚喵');
    assert.equal(row.outcome, 'delivered');
    assert.equal(row.rendered_at, 1720000000000);
    assert.equal(row.outcome_at, null, 'outcome_at should be null for delivered (pending resolution)');
  });

  it('records a context_suppressed event', () => {
    const eventId = store.recordSuppressed({
      threadId: 'thread_abc',
      entityId: 'concept:猫猫共犯宣言',
      aliasMatched: '猫猫共犯宣言',
      sourceFamily: 'doc_aliases',
      aliasClass: 'doc_title',
      renderedAt: 1720000000000,
      reason: 'context_suppressed',
    });
    assert.ok(eventId);
    const row = db.prepare('SELECT * FROM entity_nudge_events WHERE event_id = ?').get(eventId);
    assert.equal(row.outcome, 'context_suppressed');
  });

  // ── Cooldown query (replaces in-memory singleton) ──

  it('lastRenderedAt returns null when no events for entity+thread', () => {
    const result = store.lastRenderedAt('concept:未婚喵', 'thread_abc');
    assert.equal(result, null);
  });

  it('lastRenderedAt returns the most recent rendered_at for entity+thread', () => {
    store.recordDelivered({
      threadId: 'thread_abc',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000000000,
    });
    store.recordDelivered({
      threadId: 'thread_abc',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000086400, // 86400ms later
    });
    const result = store.lastRenderedAt('concept:未婚喵', 'thread_abc');
    assert.equal(result, 1720000086400);
  });

  it('lastRenderedAt scopes to the given thread', () => {
    store.recordDelivered({
      threadId: 'thread_abc',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000000000,
    });
    // Different thread — should not affect
    const result = store.lastRenderedAt('concept:未婚喵', 'thread_xyz');
    assert.equal(result, null);
  });

  // ── Outcome resolution ──

  it('resolveOutcome updates outcome and outcome_at for a delivered event', () => {
    const eventId = store.recordDelivered({
      threadId: 'thread_abc',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000000000,
    });
    store.resolveOutcome(eventId, 'followed', 1720000060000);
    const row = db.prepare('SELECT * FROM entity_nudge_events WHERE event_id = ?').get(eventId);
    assert.equal(row.outcome, 'followed');
    assert.equal(row.outcome_at, 1720000060000);
  });

  // ── Query by bucket ──

  it('queryByOutcome returns events filtered by outcome bucket', () => {
    store.recordDelivered({
      threadId: 'thread_abc',
      entityId: 'concept:未婚喵',
      aliasMatched: '未婚喵',
      sourceFamily: 'entity_registry',
      aliasClass: 'exact',
      renderedAt: 1720000000000,
    });
    const suppressedId = store.recordSuppressed({
      threadId: 'thread_abc',
      entityId: 'concept:猫猫共犯宣言',
      aliasMatched: '猫猫共犯宣言',
      sourceFamily: 'doc_aliases',
      aliasClass: 'doc_title',
      renderedAt: 1720000000000,
      reason: 'context_suppressed',
    });

    const suppressed = store.queryByOutcome('context_suppressed');
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].event_id, suppressedId);

    const delivered = store.queryByOutcome('delivered');
    assert.equal(delivered.length, 1);
  });

  // ── Valid outcomes only ──

  it('rejects invalid outcome values', () => {
    assert.throws(() => {
      store.recordSuppressed({
        threadId: 'thread_abc',
        entityId: 'concept:test',
        aliasMatched: 'test',
        sourceFamily: 'entity_registry',
        aliasClass: 'exact',
        renderedAt: 1720000000000,
        reason: 'invalid_bucket',
      });
    });
  });
});
