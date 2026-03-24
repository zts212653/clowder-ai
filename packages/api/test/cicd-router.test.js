// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { buildCiMessageContent, CiCdRouter } from '../dist/infrastructure/email/CiCdRouter.js';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';

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

/**
 * @param {Partial<import('../dist/infrastructure/email/CiCdRouter.js').CiPollResult>} [overrides]
 * @returns {import('../dist/infrastructure/email/CiCdRouter.js').CiPollResult}
 */
function makePollResult(overrides = {}) {
  return {
    repoFullName: 'zts212653/cat-cafe',
    prNumber: 42,
    headSha: 'abc1234567890',
    prState: 'open',
    aggregateBucket: 'fail',
    checks: [
      { name: 'build', bucket: 'fail', link: 'https://github.com/run/1' },
      { name: 'lint', bucket: 'pass' },
    ],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('CiCdRouter', () => {
  /** @type {MemoryPrTrackingStore} */
  let prTrackingStore;
  /** @type {ReturnType<typeof mockMessageStore>} */
  let messageMock;
  /** @type {ReturnType<typeof mockSocketManager>} */
  let socketMock;

  function createRouter() {
    return new CiCdRouter({
      prTrackingStore,
      deliveryDeps: { messageStore: messageMock.store, socketManager: socketMock.manager },
      log: noopLog(),
    });
  }

  beforeEach(() => {
    prTrackingStore = new MemoryPrTrackingStore();
    messageMock = mockMessageStore();
    socketMock = mockSocketManager();
  });

  // ── AC-A6: Unregistered PR skipped ──────────────────────────────

  describe('unregistered PR', () => {
    it('skips when no tracking entry (AC-A6)', async () => {
      const router = createRouter();
      const result = await router.route(makePollResult());
      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('No tracking entry'));
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  // ── AC-A1/A2/A3: Basic delivery ────────────────────────────────

  describe('delivery', () => {
    it('delivers CI failure message to tracked thread (AC-A1)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makePollResult({ aggregateBucket: 'fail' }));

      assert.strictEqual(result.kind, 'notified');
      if (result.kind === 'notified') {
        assert.strictEqual(result.threadId, 'thread-abc');
        assert.strictEqual(result.catId, 'opus');
        assert.strictEqual(result.bucket, 'fail');
      }
      assert.strictEqual(messageMock.messages.length, 1);
      assert.ok(messageMock.messages[0].content.includes('CI 失败'));
      assert.strictEqual(messageMock.messages[0].source.connector, 'github-ci');
    });

    it('delivers CI success message to tracked thread (AC-A3)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makePollResult({ aggregateBucket: 'pass', checks: [] }));

      assert.strictEqual(result.kind, 'notified');
      if (result.kind === 'notified') {
        assert.strictEqual(result.bucket, 'pass');
      }
      assert.strictEqual(messageMock.messages.length, 1);
      assert.ok(messageMock.messages[0].content.includes('CI 通过'));
    });

    it('returns full formatted content in notified result (P2-1 regression)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const poll = makePollResult({
        aggregateBucket: 'fail',
        checks: [{ name: 'build', bucket: 'fail', link: 'https://example.com/1' }],
      });
      const result = await router.route(poll);

      assert.strictEqual(result.kind, 'notified');
      if (result.kind === 'notified') {
        assert.ok(result.content.includes('CI 失败'), 'content should include CI failure message');
        assert.ok(result.content.includes('build'), 'content should include failed check name');
        assert.strictEqual(result.content, messageMock.messages[0].content, 'content matches delivered message');
      }
    });

    it('skips pending CI without sending message', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makePollResult({ aggregateBucket: 'pending' }));

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('pending'));
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  // ── T1: Same SHA dedup (AC-A4, AC-A5) ──────────────────────────

  describe('T1: same SHA dedup', () => {
    it('same SHA + same bucket notifies only once (AC-A4)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const poll = makePollResult({ headSha: 'sha-fixed', aggregateBucket: 'fail' });

      const r1 = await router.route(poll);
      assert.strictEqual(r1.kind, 'notified');

      const r2 = await router.route(poll);
      assert.strictEqual(r2.kind, 'deduped');

      assert.strictEqual(messageMock.messages.length, 1);
    });

    it('fail then success on same SHA notifies both (AC-A5)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const failPoll = makePollResult({ headSha: 'sha-fixed', aggregateBucket: 'fail' });
      const passPoll = makePollResult({ headSha: 'sha-fixed', aggregateBucket: 'pass', checks: [] });

      const r1 = await router.route(failPoll);
      assert.strictEqual(r1.kind, 'notified');

      const r2 = await router.route(passPoll);
      assert.strictEqual(r2.kind, 'notified');

      assert.strictEqual(messageMock.messages.length, 2);
      assert.ok(messageMock.messages[0].content.includes('CI 失败'));
      assert.ok(messageMock.messages[1].content.includes('CI 通过'));
    });
  });

  // ── T2: New push resets fingerprint (AC-A9) ─────────────────────

  describe('T2: new push resets fingerprint', () => {
    it('SHA change re-notifies even for same conclusion (AC-A9)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const poll1 = makePollResult({ headSha: 'sha-v1', aggregateBucket: 'fail' });
      const poll2 = makePollResult({ headSha: 'sha-v2', aggregateBucket: 'fail' });

      const r1 = await router.route(poll1);
      assert.strictEqual(r1.kind, 'notified');

      const r2 = await router.route(poll2);
      assert.strictEqual(r2.kind, 'notified');

      assert.strictEqual(messageMock.messages.length, 2);
    });
  });

  // ── T3: Merged/closed auto remove (AC-A8) ──────────────────────

  describe('T3: merged/closed auto remove', () => {
    it('merged PR is removed from tracking store (AC-A8)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makePollResult({ prState: 'merged' }));

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('merged'));

      const entry = prTrackingStore.get('zts212653/cat-cafe', 42);
      assert.strictEqual(entry, null);
    });

    it('closed PR is removed from tracking store', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makePollResult({ prState: 'closed' }));

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('closed'));

      const entry = prTrackingStore.get('zts212653/cat-cafe', 42);
      assert.strictEqual(entry, null);
    });
  });

  // ── AC-A10: patchCiState does not reset registeredAt ────────────

  describe('patchCiState preservation (AC-A10)', () => {
    it('CI delivery does not change registeredAt', async () => {
      const router = createRouter();
      const registered = prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });
      const originalRegisteredAt = registered.registeredAt;

      await router.route(makePollResult({ aggregateBucket: 'fail' }));

      const updated = prTrackingStore.get('zts212653/cat-cafe', 42);
      assert.ok(updated, 'entry should still exist after CI delivery');
      assert.strictEqual(updated.registeredAt, originalRegisteredAt);
      assert.ok(updated.lastCiFingerprint);
      assert.strictEqual(updated.lastCiBucket, 'fail');
    });
  });

  // ── CI tracking disabled ────────────────────────────────────────

  describe('ciTrackingEnabled toggle', () => {
    it('skips PR when ciTrackingEnabled is false', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });
      prTrackingStore.patchCiState('zts212653/cat-cafe', 42, { ciTrackingEnabled: false });

      const result = await router.route(makePollResult());

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('disabled'));
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  // ── Socket broadcast ────────────────────────────────────────────

  describe('realtime connector event', () => {
    it('broadcasts connector_message to thread room', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makePollResult());

      assert.strictEqual(socketMock.events.length, 1);
      const evt = socketMock.events[0];
      assert.strictEqual(evt.room, 'thread:thread-abc');
      assert.strictEqual(evt.event, 'connector_message');
      assert.ok(evt.payload.message.source.connector === 'github-ci');
    });
  });

  // ── Pending updates headSha ─────────────────────────────────────

  describe('pending updates headSha', () => {
    it('pending poll updates headSha without notifying', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makePollResult({ headSha: 'new-sha', aggregateBucket: 'pending' }));

      const entry = prTrackingStore.get('zts212653/cat-cafe', 42);
      assert.ok(entry, 'entry should exist with updated headSha');
      assert.strictEqual(entry.headSha, 'new-sha');
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });
});

// ─── buildCiMessageContent unit tests ──────────────────────────────

describe('buildCiMessageContent', () => {
  it('formats failure message with check details', () => {
    const content = buildCiMessageContent({
      repoFullName: 'org/repo',
      prNumber: 10,
      headSha: 'abc1234567890',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [
        { name: 'build', bucket: 'fail', link: 'https://example.com/1', description: 'Build failed' },
        { name: 'lint', bucket: 'pass' },
      ],
    });

    assert.ok(content.includes('CI 失败'));
    assert.ok(content.includes('PR #10'));
    assert.ok(content.includes('abc1234'));
    assert.ok(content.includes('build'));
    assert.ok(content.includes('Build failed'));
    assert.ok(!content.includes('lint'));
  });

  it('formats success message without check details', () => {
    const content = buildCiMessageContent({
      repoFullName: 'org/repo',
      prNumber: 10,
      headSha: 'def7890123456',
      prState: 'open',
      aggregateBucket: 'pass',
      checks: [],
    });

    assert.ok(content.includes('CI 通过'));
    assert.ok(content.includes('def7890'));
    assert.ok(!content.includes('失败的检查'));
  });
});
