import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { AntigravityStepStoreReader } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityStepStoreReader.js';

// Build a fixture conversation db matching the real Antigravity `steps` schema (idx PK + blobs).
function makeConversationDb(appDataDir, conversationId, steps, { withStepsTable = true } = {}) {
  const dir = path.join(appDataDir, 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${conversationId}.db`));
  if (withStepsTable) {
    db.exec(
      'CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `status` integer NOT NULL DEFAULT 0, `has_subtrajectory` numeric NOT NULL DEFAULT 0, `metadata` blob, `error_details` blob, `permissions` blob, `task_details` blob, `render_info` blob, `step_payload` blob, `step_format` integer NOT NULL DEFAULT 0, PRIMARY KEY (`idx`));',
    );
    const ins = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
    for (const s of steps) ins.run(s.idx, s.stepType ?? 0, s.status ?? 0, s.payload ?? Buffer.from('x'));
  } else {
    db.exec('CREATE TABLE other (id integer);');
  }
  db.close();
}

function tempAppDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-step-store-'));
}

test('reads steps incrementally with tail-overlap from cursor', () => {
  const appDataDir = tempAppDataDir();
  makeConversationDb(appDataDir, 'conv1', [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }, { idx: 4 }]);
  const reader = new AntigravityStepStoreReader({ appDataDir, tailWindow: 2 });
  const result = reader.readSince('conv1', 3);
  assert.equal(result.ok, true);
  // tail-overlap: idx >= max(0, lastSeen - tailWindow) = max(0, 3 - 2) = 1 → idx 1,2,3,4
  assert.deepEqual(
    result.steps.map((s) => s.idx),
    [1, 2, 3, 4],
  );
  assert.equal(result.maxIdx, 4);
});

test('first read (null cursor) returns all steps from idx 0', () => {
  const appDataDir = tempAppDataDir();
  makeConversationDb(appDataDir, 'conv2', [{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
  const reader = new AntigravityStepStoreReader({ appDataDir, tailWindow: 3 });
  const result = reader.readSince('conv2', null);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s) => s.idx),
    [0, 1, 2],
  );
});

test('fail-closed (no_db) when conversation db is missing', () => {
  const appDataDir = tempAppDataDir();
  const reader = new AntigravityStepStoreReader({ appDataDir });
  const result = reader.readSince('nonexistent', null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_db');
});

test('fail-closed (schema_drift) when steps table is missing', () => {
  const appDataDir = tempAppDataDir();
  makeConversationDb(appDataDir, 'conv3', [], { withStepsTable: false });
  const reader = new AntigravityStepStoreReader({ appDataDir });
  const result = reader.readSince('conv3', null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_drift');
});

test('exposes payload byte length without decoding payload (L1 only)', () => {
  const appDataDir = tempAppDataDir();
  makeConversationDb(appDataDir, 'conv4', [
    { idx: 0, payload: Buffer.alloc(100) },
    { idx: 1, payload: Buffer.alloc(250) },
  ]);
  const reader = new AntigravityStepStoreReader({ appDataDir, tailWindow: 3 });
  const result = reader.readSince('conv4', null);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s) => s.payloadBytes),
    [100, 250],
  );
});

test('tail-overlap re-read picks up in-place status mutation of an already-seen step', () => {
  const appDataDir = tempAppDataDir();
  const convId = 'conv-mut';
  makeConversationDb(appDataDir, convId, [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }]);
  const reader = new AntigravityStepStoreReader({ appDataDir, tailWindow: 2 });
  const first = reader.readSince(convId, null);
  assert.equal(first.ok, true);
  assert.equal(first.steps.find((s) => s.idx === 3)?.status, 0);
  // Antigravity mutates idx 3 in place (e.g. generating → done) via a separate writer connection.
  const writer = new Database(path.join(appDataDir, 'conversations', `${convId}.db`));
  writer.prepare('UPDATE steps SET status = ? WHERE idx = ?').run(5, 3);
  writer.close();
  // next poll with cursor=3, tailWindow=2 re-reads idx >= 1 and sees the mutated status (not a pure idx>last miss).
  const second = reader.readSince(convId, 3);
  assert.equal(second.ok, true);
  assert.deepEqual(
    second.steps.map((s) => s.idx),
    [1, 2, 3],
  );
  assert.equal(second.steps.find((s) => s.idx === 3)?.status, 5);
});

test('fail-closed (invalid_id) rejects path-traversal conversationId', () => {
  const appDataDir = tempAppDataDir();
  fs.mkdirSync(path.join(appDataDir, 'conversations'), { recursive: true });
  // Plant a db OUTSIDE conversations/ that a traversal would otherwise reach.
  const outside = new Database(path.join(appDataDir, 'outside.db'));
  outside.exec(
    'CREATE TABLE `steps` (`idx` integer PRIMARY KEY, `step_type` integer NOT NULL DEFAULT 0, `status` integer NOT NULL DEFAULT 0, `step_payload` blob, `step_format` integer NOT NULL DEFAULT 0);',
  );
  outside.prepare('INSERT INTO steps (idx, step_payload) VALUES (0, ?)').run(Buffer.from('secret'));
  outside.close();
  const reader = new AntigravityStepStoreReader({ appDataDir });
  const r = reader.readSince('../outside', null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_id'); // must NOT read appDataDir/outside.db via traversal
});

test('normalizes invalid tailWindow (negative) so tail-overlap contract holds', () => {
  const appDataDir = tempAppDataDir();
  const conv = 'conv-neg-tw';
  makeConversationDb(appDataDir, conv, [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }, { idx: 4 }]);
  // tailWindow=-2 must NOT push lowerBound to lastSeen+2 (would break mutation re-read);
  // normalized to default 3 → idx >= max(0, 4-3)=1.
  const reader = new AntigravityStepStoreReader({ appDataDir, tailWindow: -2 });
  const r = reader.readSince(conv, 4);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.steps.map((s) => s.idx),
    [1, 2, 3, 4],
  );
});

test('read_error (distinct from schema_drift) when db file is corrupt', () => {
  const appDataDir = tempAppDataDir();
  const conv = 'conv-corrupt';
  fs.mkdirSync(path.join(appDataDir, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(appDataDir, 'conversations', `${conv}.db`), 'not a sqlite database at all');
  const reader = new AntigravityStepStoreReader({ appDataDir });
  const r = reader.readSince(conv, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'read_error'); // corrupt open/read → read_error, NOT schema_drift
});
