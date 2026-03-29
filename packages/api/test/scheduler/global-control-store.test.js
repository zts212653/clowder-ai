/**
 * F139 Phase 3B: GlobalControlStore — two-layer scheduler control (AC-D1)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

let db;
let GlobalControlStore;

describe('GlobalControlStore', () => {
  beforeEach(async () => {
    db = new Database(':memory:');
    applyMigrations(db);
    const mod = await import('../../dist/infrastructure/scheduler/GlobalControlStore.js');
    GlobalControlStore = mod.GlobalControlStore;
  });

  test('getGlobalEnabled returns true by default', () => {
    const store = new GlobalControlStore(db);
    assert.equal(store.getGlobalEnabled(), true);
  });

  test('getGlobalState returns full state', () => {
    const store = new GlobalControlStore(db);
    const state = store.getGlobalState();
    assert.equal(state.enabled, true);
    assert.equal(state.updatedBy, 'system');
    assert.ok(state.updatedAt);
  });

  test('setGlobalEnabled toggles and records reason + updatedBy', () => {
    const store = new GlobalControlStore(db);
    store.setGlobalEnabled(false, '维护中', 'user');
    assert.equal(store.getGlobalEnabled(), false);
    const state = store.getGlobalState();
    assert.equal(state.reason, '维护中');
    assert.equal(state.updatedBy, 'user');
  });

  test('setGlobalEnabled back to true clears reason', () => {
    const store = new GlobalControlStore(db);
    store.setGlobalEnabled(false, 'test', 'opus');
    store.setGlobalEnabled(true, null, 'opus');
    assert.equal(store.getGlobalEnabled(), true);
    assert.equal(store.getGlobalState().reason, null);
  });

  test('getTaskOverride returns null when no override', () => {
    const store = new GlobalControlStore(db);
    assert.equal(store.getTaskOverride('unknown-task'), null);
  });

  test('setTaskOverride creates override', () => {
    const store = new GlobalControlStore(db);
    store.setTaskOverride('task-1', false, 'opus');
    const o = store.getTaskOverride('task-1');
    assert.ok(o);
    assert.equal(o.enabled, false);
    assert.equal(o.updatedBy, 'opus');
  });

  test('setTaskOverride updates existing override', () => {
    const store = new GlobalControlStore(db);
    store.setTaskOverride('task-1', false, 'opus');
    store.setTaskOverride('task-1', true, 'user');
    const o = store.getTaskOverride('task-1');
    assert.equal(o.enabled, true);
    assert.equal(o.updatedBy, 'user');
  });

  test('removeTaskOverride returns true when exists', () => {
    const store = new GlobalControlStore(db);
    store.setTaskOverride('task-1', false, 'opus');
    assert.equal(store.removeTaskOverride('task-1'), true);
    assert.equal(store.getTaskOverride('task-1'), null);
  });

  test('removeTaskOverride returns false when not exists', () => {
    const store = new GlobalControlStore(db);
    assert.equal(store.removeTaskOverride('nope'), false);
  });

  test('listOverrides returns all overrides', () => {
    const store = new GlobalControlStore(db);
    store.setTaskOverride('a', false, 'opus');
    store.setTaskOverride('b', true, 'user');
    const list = store.listOverrides();
    assert.equal(list.length, 2);
    const ids = list.map((o) => o.taskId);
    assert.ok(ids.includes('a'));
    assert.ok(ids.includes('b'));
  });
});
