// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { MemoryProcessedEmailStore } from '../dist/infrastructure/email/ProcessedEmailStore.js';
import { MemoryPrTrackingStore } from '../dist/infrastructure/email/PrTrackingStore.js';
import { ReviewRouter } from '../dist/infrastructure/email/ReviewRouter.js';

// ─── Lightweight mocks ─────────────────────────────────────────────

/** @returns {import('../dist/domains/cats/services/stores/ports/ThreadStore.js').IThreadStore} */
function mockThreadStore() {
  let counter = 0;
  /** @type {Map<string, {id: string, title: string | null, createdBy: string, projectPath: string, participants: string[], lastActiveAt: number, createdAt: number}>} */
  const threads = new Map();
  return {
    create(userId, title) {
      counter++;
      const thread = {
        id: `thread-${counter}`,
        title: title ?? null,
        createdBy: userId,
        projectPath: '',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
      threads.set(thread.id, thread);
      return thread;
    },
    get(id) {
      return threads.get(id) ?? null;
    },
    list() {
      return [];
    },
    listByProject() {
      return [];
    },
    addParticipants() {},
    getParticipants() {
      return [];
    },
    updateTitle() {},
    updatePin() {},
    updateFavorite() {},
    updateThinkingMode() {},
    updatePreferredCats() {},
    updateLastActive() {},
    delete() {
      return false;
    },
  };
}

/** @returns {{ store: import('../dist/domains/cats/services/stores/ports/MessageStore.js').IMessageStore, messages: Array<{threadId: string, userId: string, content: string, mentions: string[], timestamp: number, source?: object}> }} */
function mockMessageStore() {
  /** @type {Array<{threadId: string, userId: string, content: string, mentions: string[], timestamp: number, source?: object}>} */
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
        timestamp: msg.timestamp,
        source: msg.source,
      });
      return { id: `msg-${counter}`, ...msg };
    },
  });
  return { store, messages };
}

/** @returns {{ manager: { broadcastToRoom: (room: string, event: string, payload: unknown) => void }, events: Array<{room: string, event: string, payload: unknown}> }} */
function mockSocketManager() {
  /** @type {Array<{room: string, event: string, payload: unknown}>} */
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

// ─── Helper to create review events ────────────────────────────────

/**
 * @param {Partial<import('../dist/infrastructure/email/GithubReviewWatcher.js').GithubReviewEvent>} [overrides]
 * @returns {import('../dist/infrastructure/email/GithubReviewWatcher.js').GithubReviewEvent}
 */
function makeEvent(overrides = {}) {
  return {
    prNumber: 42,
    repository: 'zts212653/cat-cafe',
    title: '[布偶猫🐾] feat(audit): add timestamps',
    reviewType: 'approved',
    reviewer: 'codex-bot',
    catTag: '布偶猫',
    catId: 'opus',
    emailUid: 1000,
    receivedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('ReviewRouter', () => {
  /** @type {MemoryPrTrackingStore} */
  let prTrackingStore;
  /** @type {MemoryProcessedEmailStore} */
  let processedEmailStore;
  /** @type {ReturnType<typeof mockThreadStore>} */
  let threadStore;
  /** @type {ReturnType<typeof mockMessageStore>} */
  let messageMock;
  /** @type {ReturnType<typeof mockSocketManager>} */
  let socketMock;

  /** @param {Partial<import('../dist/infrastructure/email/ReviewRouter.js').ReviewRouterOptions>} [overrides] */
  function createRouter(overrides = {}) {
    return new ReviewRouter({
      prTrackingStore,
      processedEmailStore,
      threadStore,
      messageStore: messageMock.store,
      socketManager: socketMock.manager,
      log: noopLog(),
      ...overrides,
    });
  }

  beforeEach(() => {
    prTrackingStore = new MemoryPrTrackingStore();
    processedEmailStore = new MemoryProcessedEmailStore();
    threadStore = mockThreadStore();
    messageMock = mockMessageStore();
    socketMock = mockSocketManager();
  });

  // ── Dedup ────────────────────────────────────────────────────────

  describe('dedup', () => {
    it('skips already-processed email UID', async () => {
      const router = createRouter();
      processedEmailStore.markProcessed(1000);

      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('already processed'));
    });

    it('skips PR in dedup window (registered PR)', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });
      processedEmailStore.markPrInvoked('zts212653/cat-cafe', 42);

      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('recently invoked'));
    });

    it('unregistered PR does not claim dedup window (#668 P1)', async () => {
      const router = createRouter();

      const r1 = await router.route(makeEvent({ emailUid: 3001 }));
      assert.strictEqual(r1.kind, 'skipped');
      assert.ok(r1.reason.includes('No tracking entry'));

      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const r2 = await router.route(makeEvent({ emailUid: 3002 }));
      assert.strictEqual(r2.kind, 'routed');
      if (r2.kind === 'routed') {
        assert.strictEqual(r2.catId, 'opus');
        assert.strictEqual(r2.threadId, 'thread-abc');
      }
      assert.strictEqual(messageMock.messages.length, 1);
    });
  });

  // ── Layer 1: Registry ────────────────────────────────────────────

  describe('Layer 1: PrTrackingStore registry', () => {
    it('routes to tracked thread+cat', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makeEvent());

      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.strictEqual(result.threadId, 'thread-abc');
        assert.strictEqual(result.catId, 'opus');
        assert.strictEqual(result.source, 'registry');
      }

      // Should have posted a message
      assert.strictEqual(messageMock.messages.length, 1);
      assert.strictEqual(messageMock.messages[0].threadId, 'thread-abc');
      assert.ok(messageMock.messages[0].content.includes('GitHub Review 通知'));
      assert.deepStrictEqual(messageMock.messages[0].mentions, ['opus']);

      // Should mark as processed + pr invoked
      assert.strictEqual(processedEmailStore.isProcessed(1000), true);
      assert.strictEqual(processedEmailStore.isPrRecentlyInvoked('zts212653/cat-cafe', 42), true);
    });
  });

  // ── Unregistered PR: skip (#668) ──────────────────────────────────

  describe('Unregistered PR skip (#668)', () => {
    it('skips when cat tag present but no tracking entry', async () => {
      const router = createRouter();

      const result = await router.route(makeEvent());

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('No tracking entry'));

      // No message should be posted
      assert.strictEqual(messageMock.messages.length, 0);
    });

    it('skips when no tracking and no cat tag', async () => {
      const router = createRouter();

      const result = await router.route(
        makeEvent({
          catTag: undefined,
          catId: '',
          title: 'Some PR without cat tag (#42)',
        }),
      );

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('No tracking entry'));

      // No message should be posted, no thread created
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  // ── Message content ──────────────────────────────────────────────

  describe('message content', () => {
    it('includes review type in routed message', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makeEvent({ reviewType: 'changes_requested' }));

      assert.ok(messageMock.messages[0].content.includes('Changes Requested'));
    });

    it('includes reviewer in message when present', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makeEvent({ reviewer: 'codex-bot' }));

      assert.ok(messageMock.messages[0].content.includes('@codex-bot'));
    });

    it('omits reviewer line when not present', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makeEvent({ reviewer: undefined }));

      assert.ok(!messageMock.messages[0].content.includes('Reviewer:'));
    });
  });

  // ── Registry takes priority over fallback ────────────────────────

  describe('priority', () => {
    it('registry takes priority even when cat tag is present', async () => {
      const router = createRouter();

      // Both registry and cat tag available
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'codex',
        threadId: 'registry-thread',
        userId: 'user-1',
      });

      const result = await router.route(
        makeEvent({
          catTag: '布偶猫',
          catId: 'opus',
        }),
      );

      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        // Registry cat (codex) should win over tag cat (opus)
        assert.strictEqual(result.catId, 'codex');
        assert.strictEqual(result.threadId, 'registry-thread');
        assert.strictEqual(result.source, 'registry');
      }
    });

    // P1-2 regression: registry hit must work even without catTag in title
    it('registry routes correctly when event has no catTag', async () => {
      const router = createRouter();

      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(
        makeEvent({
          catTag: undefined,
          catId: undefined,
          title: 'feat(audit): add timestamps (#42)',
        }),
      );

      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.strictEqual(result.catId, 'opus');
        assert.strictEqual(result.threadId, 'thread-abc');
        assert.strictEqual(result.source, 'registry');
      }
    });
  });

  // ── P1 regression: message userId must not be 'system' ───────────

  describe('message userId (砚砚 R2 P1)', () => {
    it('registry hit: message userId comes from tracking.userId', async () => {
      const router = createRouter();

      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'real-user-42',
      });

      await router.route(makeEvent());

      assert.strictEqual(messageMock.messages.length, 1);
      assert.strictEqual(messageMock.messages[0].userId, 'real-user-42');
    });

    it('registry hit: stale tracking userId falls back to thread owner', async () => {
      const router = createRouter();
      const ownerThread = threadStore.create('alice', 'Owner thread');

      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: ownerThread.id,
        userId: 'stale-user',
      });

      const result = await router.route(makeEvent());

      assert.strictEqual(messageMock.messages.length, 1);
      assert.strictEqual(messageMock.messages[0].userId, 'alice');
      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.strictEqual(result.userId, 'alice');
      }
    });

    it('unregistered PR skips without posting message regardless of defaultUserId', async () => {
      const router = createRouter({ defaultUserId: 'configured-user' });

      const result = await router.route(makeEvent());

      assert.strictEqual(result.kind, 'skipped');
      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  // ── Cloud Codex P1-1: dedup markers must come AFTER delivery ──────

  describe('dedup-after-delivery (cloud Codex P1-1)', () => {
    it('retries delivery when messageStore.append throws', async () => {
      let appendCallCount = 0;
      const failingMessageStore = /** @type {any} */ ({
        append(msg) {
          appendCallCount++;
          if (appendCallCount === 1) {
            throw new Error('transient store failure');
          }
          return { id: 'msg-1', ...msg };
        },
      });

      const router = createRouter({ messageStore: failingMessageStore });

      // Register tracking so we route via Layer 1
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      // First call: append throws
      await assert.rejects(() => router.route(makeEvent()), /transient store failure/);

      assert.strictEqual(processedEmailStore.isProcessed(1000), false);
      assert.strictEqual(processedEmailStore.isPrRecentlyInvoked('zts212653/cat-cafe', 42), false);

      // Second call: should retry successfully
      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'routed');
      assert.strictEqual(appendCallCount, 2);
    });
  });

  // ── Cloud Codex P1-2: concurrent PR dedup must be atomic ──────────

  describe('concurrent PR dedup (cloud Codex P1-2)', () => {
    it('only one of two concurrent routes for same PR succeeds', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const e1 = makeEvent({ emailUid: 2001 });
      const e2 = makeEvent({ emailUid: 2002 });

      const [r1, r2] = await Promise.all([router.route(e1), router.route(e2)]);

      const routed = [r1, r2].filter((r) => r.kind === 'routed');
      const skipped = [r1, r2].filter((r) => r.kind === 'skipped');

      assert.strictEqual(routed.length, 1, 'exactly one should be routed');
      assert.strictEqual(skipped.length, 1, 'exactly one should be skipped by PR dedup');

      assert.strictEqual(messageMock.messages.length, 1);
    });
  });

  // ── F97 Phase 3b: RouteResult includes messageId + content + userId ──

  describe('RouteResult fields (F97 Phase 3b)', () => {
    it('registry route returns messageId from stored message', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makeEvent());

      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.ok(result.messageId, 'should have messageId');
        assert.ok(result.messageId.startsWith('msg-'), `messageId should be from store: ${result.messageId}`);
        assert.ok(result.content.includes('GitHub Review 通知'));
        assert.strictEqual(result.userId, 'user-1');
      }
    });

    it('unregistered PR returns skipped with reason', async () => {
      const router = createRouter({ defaultUserId: 'default-user' });

      const result = await router.route(makeEvent());

      assert.strictEqual(result.kind, 'skipped');
      assert.ok(result.reason.includes('No tracking entry'));
    });
  });

  // ── F97: ConnectorSource field ─────────────────────────────────────

  describe('ConnectorSource (F97)', () => {
    it('routed message includes ConnectorSource with github-review connector', async () => {
      const router = createRouter();

      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makeEvent());

      const msg = messageMock.messages[0];
      assert.ok(msg.source, 'message should have source field');
      assert.strictEqual(msg.source.connector, 'github-review');
      assert.strictEqual(msg.source.label, 'GitHub Review');
      assert.strictEqual(msg.source.icon, 'github');
      assert.strictEqual(msg.source.url, 'https://github.com/zts212653/cat-cafe/pull/42');
    });

    it('unregistered PR produces no ConnectorSource message', async () => {
      const router = createRouter();

      await router.route(makeEvent({ prNumber: 99, repository: 'org/repo' }));

      assert.strictEqual(messageMock.messages.length, 0);
    });
  });

  describe('realtime connector event', () => {
    it('broadcasts connector_message to routed thread', async () => {
      const router = createRouter();
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      await router.route(makeEvent());

      assert.strictEqual(socketMock.events.length, 1);
      const evt = socketMock.events[0];
      assert.strictEqual(evt.room, 'thread:thread-abc');
      assert.strictEqual(evt.event, 'connector_message');
      assert.deepStrictEqual(evt.payload, {
        threadId: 'thread-abc',
        message: {
          id: 'msg-1',
          type: 'connector',
          content: messageMock.messages[0].content,
          source: messageMock.messages[0].source,
          timestamp: messageMock.messages[0].timestamp,
        },
      });
    });

    it('does not broadcast when PR is unregistered', async () => {
      const router = createRouter();

      await router.route(makeEvent({ catTag: undefined, catId: undefined }));

      assert.strictEqual(socketMock.events.length, 0);
    });
  });

  // ── Integration: ReviewRouter + reviewContentFetcher (砚砚 P2-new-3) ──

  describe('reviewContentFetcher integration', () => {
    it('includes severity findings when fetcher returns P1', async () => {
      /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').IReviewContentFetcher} */
      const mockFetcher = {
        async fetch() {
          return {
            findings: [
              { severity: 'P1', excerpt: 'race condition in flush', source: 'inline_comment', path: 'src/x.ts' },
            ],
            maxSeverity: 'P1',
            fetchFailed: false,
          };
        },
      };

      const router = createRouter({ reviewContentFetcher: mockFetcher });
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.ok(result.content.includes('Review 检测到 P1'), 'should include severity header');
        assert.ok(result.content.includes('race condition'), 'should include finding excerpt');
      }
    });

    it('shows fetch-failure warning when fetcher partially fails', async () => {
      /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').IReviewContentFetcher} */
      const mockFetcher = {
        async fetch() {
          return {
            findings: [],
            maxSeverity: null,
            fetchFailed: true,
          };
        },
      };

      const router = createRouter({ reviewContentFetcher: mockFetcher });
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.ok(result.content.includes('未能完整拉取'), 'should warn about fetch failure');
        assert.ok(!result.content.includes('检测到'), 'should not claim severity found');
      }
    });

    it('delivers notification normally when fetcher throws', async () => {
      /** @type {import('../dist/infrastructure/email/ReviewContentFetcher.js').IReviewContentFetcher} */
      const mockFetcher = {
        async fetch() {
          throw new Error('gh CLI not found');
        },
      };

      const router = createRouter({ reviewContentFetcher: mockFetcher });
      prTrackingStore.register({
        repoFullName: 'zts212653/cat-cafe',
        prNumber: 42,
        catId: 'opus',
        threadId: 'thread-abc',
        userId: 'user-1',
      });

      const result = await router.route(makeEvent());
      assert.strictEqual(result.kind, 'routed');
      if (result.kind === 'routed') {
        assert.ok(result.content.includes('GitHub Review 通知'), 'message should still be delivered');
        assert.ok(!result.content.includes('检测到'), 'no severity claimed');
      }
      assert.strictEqual(messageMock.messages.length, 1);
    });
  });
});
