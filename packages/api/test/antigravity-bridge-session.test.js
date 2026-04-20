import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function createBridge(storePath) {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false }, { sessionStorePath: storePath });
}

describe('AntigravityBridge session persistence (G0)', () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    cleanupPaths.length = 0;
  });

  test('reuses existing cascade when alive', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    mock.method(bridge, 'startCascade', async () => 'cascade-001');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 3,
    }));

    const id1 = await bridge.getOrCreateSession('thread-1');
    assert.equal(id1, 'cascade-001');
    assert.equal(bridge.startCascade.mock.callCount(), 1);

    const id2 = await bridge.getOrCreateSession('thread-1');
    assert.equal(id2, 'cascade-001');
    assert.equal(bridge.startCascade.mock.callCount(), 1, 'should NOT create a second cascade');
  });

  test('creates new cascade when existing one is dead', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-dead': 'dead-cascade-999' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'cascade-new');
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'dead-cascade-999') throw new Error('cascade not found');
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });

    const id = await bridge.getOrCreateSession('thread-dead');
    assert.equal(id, 'cascade-new', 'should create new cascade when existing is dead');
    assert.equal(bridge.startCascade.mock.callCount(), 1);
  });

  test('persists mapping to file, loadable by new instance', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-persist');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    await bridge1.getOrCreateSession('thread-persist');

    // Verify file was written
    assert.ok(fs.existsSync(storePath), 'session store file should exist');
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-persist'], 'cascade-persist');

    // New instance should load from file
    const bridge2 = createBridge(storePath);
    mock.method(bridge2, 'startCascade', async () => 'cascade-should-not-be-called');
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 1,
    }));

    const id = await bridge2.getOrCreateSession('thread-persist');
    assert.equal(id, 'cascade-persist', 'should reuse persisted cascade');
    assert.equal(bridge2.startCascade.mock.callCount(), 0, 'should NOT create new cascade');
  });

  test('different threads get different cascades', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    const id1 = await bridge.getOrCreateSession('thread-a');
    const id2 = await bridge.getOrCreateSession('thread-b');
    assert.notEqual(id1, id2);
    assert.equal(bridge.startCascade.mock.callCount(), 2);
  });

  test('P1-1: concurrent instances merge rather than overwrite', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    // Seed file with an entry that neither bridge will touch
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-preexisting': 'cascade-old' }));

    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-a');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    // bridge1 loads file (gets thread-preexisting), creates thread-1
    await bridge1.getOrCreateSession('thread-1');

    // bridge2 loads file BEFORE bridge1's write (simulate by writing a separate entry directly)
    const bridge2 = createBridge(storePath);
    mock.method(bridge2, 'startCascade', async () => 'cascade-b');
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    await bridge2.getOrCreateSession('thread-2');

    // After both writes, ALL three entries must survive
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-preexisting'], 'cascade-old', 'pre-existing entry must survive');
    assert.equal(stored['thread-1'], 'cascade-a', 'first instance entry must survive');
    assert.equal(stored['thread-2'], 'cascade-b', 'second instance entry must exist');
  });

  test('P1-2: different catIds on same thread get separate cascades', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    const id1 = await bridge.getOrCreateSession('thread-shared', 'gemini');
    const id2 = await bridge.getOrCreateSession('thread-shared', 'opus');
    assert.notEqual(id1, id2, 'different cats must get different cascades');
    assert.equal(bridge.startCascade.mock.callCount(), 2);
  });

  test('P1-cloud: falls back to legacy threadId-only key', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    // Seed with legacy format (threadId only, no catId suffix)
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-be-called');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'opus');
    assert.equal(id, 'cascade-old', 'should find legacy key and reuse');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'should NOT create new cascade');
  });

  test('P1-cloud-2: legacy key deleted after migration, no cross-cat leak', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-new-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    // First cat migrates legacy key
    const id1 = await bridge.getOrCreateSession('thread-1', 'opus');
    assert.equal(id1, 'cascade-old', 'opus should reuse legacy cascade');

    // Second cat must NOT fall back to legacy key — it should create its own
    const id2 = await bridge.getOrCreateSession('thread-1', 'gemini');
    assert.notEqual(id2, 'cascade-old', 'gemini must not reuse opus legacy cascade');
    assert.equal(bridge.startCascade.mock.callCount(), 1, 'gemini should create new cascade');
  });

  test('P1-cloud-3: legacy deletion survives restart (not resurrected from file)', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    // First bridge: opus migrates legacy key, which should delete threadId-only key from file
    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-should-not-run');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));
    await bridge1.getOrCreateSession('thread-1', 'opus');

    // Second bridge (restart): gemini must NOT find legacy key
    const bridge2 = createBridge(storePath);
    let counter = 0;
    mock.method(bridge2, 'startCascade', async () => `cascade-gemini-${++counter}`);
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));
    const id = await bridge2.getOrCreateSession('thread-1', 'gemini');
    assert.notEqual(id, 'cascade-old', 'gemini must not reuse opus legacy cascade after restart');
    assert.equal(bridge2.startCascade.mock.callCount(), 1, 'gemini should create new cascade');
  });

  test('P2-cloud: tombstone cleared when new entry created for same key', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-fresh-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    // Migrate legacy key (tombstones 'thread-1')
    await bridge.getOrCreateSession('thread-1', 'opus');
    // Now a no-catId caller creates a new session for same threadId
    await bridge.getOrCreateSession('thread-1');

    // The new 'thread-1' entry must be persisted, not dropped by tombstone
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.ok(stored['thread-1'], 'thread-1 must exist in file after re-creation');
    assert.equal(stored['thread-1'], 'cascade-fresh-1');
  });

  test('updates persisted file when dead cascade is replaced', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-x': 'old-cascade' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'replacement-cascade');
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'old-cascade') throw new Error('dead');
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });

    await bridge.getOrCreateSession('thread-x');

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-x'], 'replacement-cascade', 'file should contain updated mapping');
  });
});
