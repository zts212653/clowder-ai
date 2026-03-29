/**
 * F139 Phase 3B: EmissionStore — self-echo suppression data layer (AC-D2)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

let db;
let EmissionStore;

describe('EmissionStore', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);
    const mod = await import('../../dist/infrastructure/scheduler/EmissionStore.js');
    EmissionStore = mod.EmissionStore;
  });

  test('record + isSuppressed returns true within TTL', () => {
    const store = new EmissionStore(db);
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-1',
      suppressionMs: 60_000,
    });
    assert.equal(store.isSuppressed('task-a', 'thread-1'), true);
  });

  test('isSuppressed returns false when no emission recorded', () => {
    const store = new EmissionStore(db);
    assert.equal(store.isSuppressed('task-a', 'thread-1'), false);
  });

  test('isSuppressed returns false after TTL expires', () => {
    const store = new EmissionStore(db);
    // Record with 0ms TTL — already expired
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-1',
      suppressionMs: 0,
    });
    assert.equal(store.isSuppressed('task-a', 'thread-1'), false);
  });

  test('different tasks on same thread are independent', () => {
    const store = new EmissionStore(db);
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-1',
      suppressionMs: 60_000,
    });
    // task-b has no emission on thread-1
    assert.equal(store.isSuppressed('task-b', 'thread-1'), false);
  });

  test('same task on different threads are independent', () => {
    const store = new EmissionStore(db);
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-1',
      suppressionMs: 60_000,
    });
    assert.equal(store.isSuppressed('task-a', 'thread-2'), false);
  });

  test('cleanup removes expired emissions', () => {
    const store = new EmissionStore(db);
    // Record with 0ms TTL — expired immediately
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-old',
      suppressionMs: 0,
    });
    // Record with long TTL — still active
    store.record({
      originTaskId: 'task-b',
      threadId: 'thread-2',
      messageId: 'msg-new',
      suppressionMs: 60_000,
    });

    const removed = store.cleanup();
    assert.equal(removed, 1, 'should remove 1 expired emission');

    // Verify: thread-2 still suppressed, thread-1 not
    assert.equal(store.isSuppressed('task-b', 'thread-2'), true);
    assert.equal(store.isSuppressed('task-a', 'thread-1'), false);
  });

  test('listActive returns only non-expired emissions', () => {
    const store = new EmissionStore(db);
    store.record({
      originTaskId: 'task-a',
      threadId: 'thread-1',
      messageId: 'msg-1',
      suppressionMs: 60_000,
    });
    store.record({
      originTaskId: 'task-b',
      threadId: 'thread-2',
      messageId: 'msg-2',
      suppressionMs: 0, // expired
    });

    const active = store.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0].originTaskId, 'task-a');
  });
});
