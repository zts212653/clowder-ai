import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { IndexStateManager } from '../../dist/domains/memory/IndexStateManager.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('IndexStateManager', () => {
  let db;
  let mgr;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
    mgr = new IndexStateManager(db);
  });

  describe('getState', () => {
    it('returns missing for unknown project', () => {
      const state = mgr.getState('/tmp/unknown');
      assert.equal(state.status, 'missing');
    });

    it('returns ready for existing project with matching fingerprint', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markReady('/tmp/foo', 10, '{"projectName":"foo"}');
      const state = mgr.getState('/tmp/foo', 'abc:1.0:full');
      assert.equal(state.status, 'ready');
    });

    it('returns stale when fingerprint differs from ready index', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markReady('/tmp/foo', 10, '{}');
      const state = mgr.getState('/tmp/foo', 'def:2.0:full');
      assert.equal(state.status, 'stale');
    });

    it('does not downgrade to stale without currentFingerprint', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markReady('/tmp/foo', 10, '{}');
      const state = mgr.getState('/tmp/foo');
      assert.equal(state.status, 'ready');
    });
  });

  describe('state transitions', () => {
    it('missing → building → ready', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      assert.equal(mgr.getState('/tmp/foo').status, 'building');

      mgr.markReady('/tmp/foo', 42, '{"projectName":"foo"}');
      const state = mgr.getState('/tmp/foo');
      assert.equal(state.status, 'ready');
      assert.equal(state.docs_indexed, 42);
      assert.ok(state.summary_json);
      assert.ok(state.last_scan_at);
    });

    it('building → failed', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markFailed('/tmp/foo', 'timeout after 30s');
      const state = mgr.getState('/tmp/foo');
      assert.equal(state.status, 'failed');
      assert.equal(state.error_message, 'timeout after 30s');
    });

    it('failed → building (retry)', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markFailed('/tmp/foo', 'crash');
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      assert.equal(mgr.getState('/tmp/foo').status, 'building');
    });

    it('stale → building (re-bootstrap)', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1.0:full');
      mgr.markReady('/tmp/foo', 10, '{}');
      mgr.startBuilding('/tmp/foo', 'def:2.0:full');
      assert.equal(mgr.getState('/tmp/foo').status, 'building');
      assert.equal(mgr.getState('/tmp/foo').fingerprint, 'def:2.0:full');
    });
  });

  describe('shouldBootstrap', () => {
    it('returns true for missing project', () => {
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), true);
    });

    it('returns false when same fingerprint already ready', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1:full');
      mgr.markReady('/tmp/foo', 10, '{}');
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), false);
    });

    it('returns true when fingerprint differs (stale)', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1:full');
      mgr.markReady('/tmp/foo', 10, '{}');
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'def:2:full'), true);
    });

    it('returns false when currently building', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1:full');
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), false);
    });

    it('returns true for failed project', () => {
      mgr.startBuilding('/tmp/foo', 'abc:1:full');
      mgr.markFailed('/tmp/foo', 'error');
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), true);
    });

    it('returns false when snoozed', () => {
      mgr.snooze('/tmp/foo');
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), false);
    });

    it('returns true when snooze expired', () => {
      mgr.snooze('/tmp/foo', -1);
      assert.equal(mgr.shouldBootstrap('/tmp/foo', 'abc:1:full'), true);
    });
  });

  describe('snooze', () => {
    it('sets snoozed_until 7 days from now by default', () => {
      mgr.snooze('/tmp/foo');
      assert.equal(mgr.isSnoozed('/tmp/foo'), true);
    });

    it('isSnoozed returns false for unknown project', () => {
      assert.equal(mgr.isSnoozed('/tmp/foo'), false);
    });

    it('isSnoozed returns false after snooze expires', () => {
      mgr.snooze('/tmp/foo', -1);
      assert.equal(mgr.isSnoozed('/tmp/foo'), false);
    });
  });

  describe('idempotency', () => {
    it('generates deterministic ID from project path', () => {
      mgr.startBuilding('/tmp/foo', 'a:1:full');
      mgr.startBuilding('/tmp/foo', 'b:2:full');
      const rows = db.prepare('SELECT COUNT(*) as cnt FROM index_state').get();
      assert.equal(rows.cnt, 1);
    });
  });
});
