// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';

// Lazy import — ConflictRouter doesn't exist yet, TDD red phase
const { ConflictRouter, buildConflictMessageContent } = await import('../dist/infrastructure/email/ConflictRouter.js');

// ─── Lightweight mocks ─────────────────────────────────────────────

function mockMessageStore() {
  const messages = [];
  let counter = 0;
  const store = /** @type {any} */ ({
    append(msg) {
      counter++;
      messages.push({
        threadId: msg.threadId,
        userId: msg.userId,
        content: msg.content,
        mentions: msg.mentions ?? [],
        timestamp: msg.timestamp ?? Date.now(),
        source: msg.source,
      });
      return { id: `msg-${counter}`, ...msg, timestamp: msg.timestamp ?? Date.now() };
    },
  });
  return { store, messages };
}

function mockSocketManager() {
  const events = [];
  return {
    manager: {
      broadcastToRoom(room, event, payload) {
        events.push({ room, event, payload });
      },
    },
    events,
  };
}

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('ConflictRouter', () => {
  /** @type {MemoryPrTrackingStore} */
  let prTrackingStore;
  let messageMock;
  let socketMock;

  function createRouter() {
    return new ConflictRouter({
      prTrackingStore,
      deliveryDeps: { messageStore: messageMock.store, socketManager: socketMock.manager },
      log: noopLog(),
    });
  }

  function seedTracking(overrides = {}) {
    return prTrackingStore.register({
      repoFullName: 'owner/repo',
      prNumber: 42,
      catId: 'opus',
      threadId: 'th-1',
      userId: 'u-1',
      ...overrides,
    });
  }

  beforeEach(() => {
    prTrackingStore = new MemoryPrTrackingStore();
    messageMock = mockMessageStore();
    socketMock = mockSocketManager();
  });

  // ── AC-A1: CONFLICTING → notified ────────────────────────────────

  it('delivers conflict message when CONFLICTING (AC-A1)', async () => {
    const router = createRouter();
    seedTracking();
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'sha1',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'notified');
    assert.equal(result.threadId, 'th-1');
    assert.equal(result.catId, 'opus');
    assert.equal(messageMock.messages.length, 1);
    assert.equal(messageMock.messages[0].source.connector, 'github-conflict');
  });

  // ── AC-A7: State-transition dedup ────────────────────────────────

  it('dedupes same headSha + same mergeState (AC-A7)', async () => {
    const router = createRouter();
    seedTracking();
    const signal = { repoFullName: 'owner/repo', prNumber: 42, headSha: 'sha1', mergeState: 'CONFLICTING' };

    const r1 = await router.route(signal);
    assert.equal(r1.kind, 'notified');

    const r2 = await router.route(signal);
    assert.equal(r2.kind, 'deduped');
    assert.equal(messageMock.messages.length, 1);
  });

  // ── KD-9: Fingerprint reset on MERGEABLE ─────────────────────────

  it('clears fingerprint on MERGEABLE, re-notifies on re-conflict (KD-9)', async () => {
    const router = createRouter();
    seedTracking();
    const conflicting = { repoFullName: 'owner/repo', prNumber: 42, headSha: 'sha1', mergeState: 'CONFLICTING' };
    const mergeable = { repoFullName: 'owner/repo', prNumber: 42, headSha: 'sha1', mergeState: 'MERGEABLE' };

    // First conflict
    const r1 = await router.route(conflicting);
    assert.equal(r1.kind, 'notified');

    // Back to MERGEABLE — clears fingerprint
    const r2 = await router.route(mergeable);
    assert.equal(r2.kind, 'skipped');

    // Same headSha conflicts again (base changed) → should re-notify
    const r3 = await router.route(conflicting);
    assert.equal(r3.kind, 'notified');
    assert.equal(messageMock.messages.length, 2);
  });

  // ── Untracked PR → skipped ───────────────────────────────────────

  it('skips unregistered PR', async () => {
    const router = createRouter();
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 999,
      headSha: 'sha1',
      mergeState: 'CONFLICTING',
    });
    assert.equal(result.kind, 'skipped');
    assert.equal(messageMock.messages.length, 0);
  });

  // ── MERGEABLE without prior conflict → skipped ───────────────────

  it('skips MERGEABLE without prior conflict', async () => {
    const router = createRouter();
    seedTracking();
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'sha1',
      mergeState: 'MERGEABLE',
    });
    assert.equal(result.kind, 'skipped');
    assert.equal(messageMock.messages.length, 0);
  });

  // ── UNKNOWN → skipped ────────────────────────────────────────────

  it('skips UNKNOWN mergeState', async () => {
    const router = createRouter();
    seedTracking();
    const result = await router.route({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'sha1',
      mergeState: 'UNKNOWN',
    });
    assert.equal(result.kind, 'skipped');
  });

  // ── Socket broadcast ─────────────────────────────────────────────

  it('broadcasts connector_message via socket', async () => {
    const router = createRouter();
    seedTracking();
    await router.route({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'sha1',
      mergeState: 'CONFLICTING',
    });
    assert.equal(socketMock.events.length, 1);
    assert.equal(socketMock.events[0].room, 'thread:th-1');
    assert.equal(socketMock.events[0].event, 'connector_message');
  });
});

// ─── buildConflictMessageContent ───────────────────────────────────

describe('buildConflictMessageContent', () => {
  it('formats conflict warning message', () => {
    const content = buildConflictMessageContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'abc1234567890',
      mergeState: 'CONFLICTING',
    });
    assert.ok(content.includes('冲突'));
    assert.ok(content.includes('PR #42'));
    assert.ok(content.includes('abc1234'));
  });

  it('includes action hint metadata for auto-response (AC-B1)', () => {
    const content = buildConflictMessageContent({
      repoFullName: 'owner/repo',
      prNumber: 42,
      headSha: 'abc1234567890',
      mergeState: 'CONFLICTING',
    });
    assert.ok(content.includes('自动处理'), 'should include action hint section');
    assert.ok(content.includes('git fetch origin main'), 'should include rebase command');
    assert.ok(content.includes('owner/repo#42'), 'should include PR reference');
    assert.ok(content.includes('KD-13'), 'should reference the design decision');
  });
});
