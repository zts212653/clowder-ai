/**
 * F254 B3 — createFreshnessReinvokeCheck factory tests.
 *
 * Tests the composition layer that bridges stores → decideFreshnessReinvoke.
 * Uses in-memory stubs (not Redis) since the pure decider is already tested.
 *
 * P1-1/P1-2 review fixes:
 * - userId is now required in check params
 * - getSeenCursor dep reads real per-(user,cat,thread) cursor (not lastNoticeToolCallNum)
 * - seenCursorCaughtUp uses message ID comparison (not unresolvedNotices.length === 0)
 * - shouldReinvoke=true returns reinvokePrompt (spec §B3 content-free prompt)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { createFreshnessReinvokeCheck } = await import(
  '../dist/domains/cats/services/freshness/createFreshnessReinvokeCheck.js'
);

// --- In-memory Redis stub ---

function createRedisStub(data = {}) {
  const store = { ...data };
  const lists = {};
  return {
    get: async (key) => store[key] ?? null,
    incr: async (key) => {
      store[key] = (Number(store[key]) || 0) + 1;
      return store[key];
    },
    ttl: async (key) => (store[`__ttl:${key}`] ? Number(store[`__ttl:${key}`]) : -1),
    expire: async (key, seconds) => {
      store[`__ttl:${key}`] = seconds;
    },
    lrange: async (key, start, end) => lists[key]?.slice(start, end === -1 ? undefined : end + 1) ?? [],
    rpush: async (key, value) => {
      if (!lists[key]) lists[key] = [];
      lists[key].push(value);
    },
    hgetall: async (key) => store[`__hash:${key}`] ?? {},
    hset: async (key, field, value) => {
      if (!store[`__hash:${key}`]) store[`__hash:${key}`] = {};
      store[`__hash:${key}`][field] = value;
    },
    hsetnx: async (key, field, value) => {
      if (!store[`__hash:${key}`]) store[`__hash:${key}`] = {};
      if (!(field in store[`__hash:${key}`])) {
        store[`__hash:${key}`][field] = value;
      }
    },
    // Expose internals for assertion
    _store: store,
    _lists: lists,
  };
}

function createMessageStoreStub(messages = []) {
  return {
    getByThread: async (threadId, limit) => messages.filter((m) => m.threadId === threadId).slice(0, limit ?? 100),
    getRecent: () => [],
    getMentionsFor: () => [],
    getBefore: () => [],
    // Score-aware: in-memory uses ID order as proxy for delivery order.
    // For late-delivery tests, override this method directly on the store object.
    getByThreadAfter: async (threadId, afterId, limit) => {
      if (!afterId) return messages.filter((m) => m.threadId === threadId).slice(0, limit ?? 100);
      return messages.filter((m) => m.threadId === threadId && m.id > afterId).slice(0, limit ?? 100);
    },
    getByThreadBefore: () => [],
    append: async (msg) => ({ ...msg, id: `msg-${Date.now()}` }),
  };
}

// --- Tests ---

describe('F254 B3 — createFreshnessReinvokeCheck', () => {
  it('returns decision (not null) with no notices and no state', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub();
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result, 'should return a decision (not null)');
    assert.equal(result.shouldReinvoke, false, 'no notices → no re-invoke');
  });

  it('returns shouldReinvoke=true when unresolved high-priority notice exists', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    // Seed event log with a notice_attached event
    const eventKey = 'freshness:events:inv:inv-1';
    redis._lists[eventKey] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, true, 'unresolved user notice → re-invoke');
    assert.ok(result.noticeIds.includes('notice-1'));
    assert.ok(result.senders.includes('user'));
  });

  it('returns shouldReinvoke=false when notice is from non-user sender (low priority)', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    // Notice from connector (not high priority in v1)
    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['connector-slack'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false, 'non-user sender = low priority → skip');
  });

  it('returns shouldReinvoke=false when quota exhausted', async () => {
    const redis = createRedisStub({
      'freshness:reinvoke_quota:opus:thread-1': '3', // MAX_REINVOKES_PER_HOUR
    });
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'quota_exhausted');
  });

  it('increments quota counter when re-invoke triggered', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    await check({ invocationId: 'inv-1', threadId: 'thread-1', catId: 'opus', userId: 'user1' });

    assert.equal(redis._store['freshness:reinvoke_quota:opus:thread-1'], 1, 'quota counter should increment');
  });

  it('returns shouldReinvoke=false when newer invocation is active', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      hasQueuedOrActiveAgentForCat: () => true, // newer invocation active
    });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'newer_invocation');
  });

  it('returns null on Redis failure (fail-open)', async () => {
    const badRedis = {
      lrange: async () => {
        throw new Error('connection refused');
      },
      get: async () => null,
      hgetall: async () => ({}),
    };
    const messageStore = createMessageStoreStub();
    const check = createFreshnessReinvokeCheck({ redis: badRedis, messageStore });

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.equal(result, null, 'should return null on failure (fail-open)');
  });

  // --- P1-1: seenCursor from getSeenCursor dep, not lastNoticeToolCallNum ---

  it('P1-1: uses getSeenCursor dep for seenCursor (not lastNoticeToolCallNum)', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);

    // getSeenCursor returns cursor that matches latest message → caught up → no re-invoke
    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async (userId, catId, threadId) => {
        assert.equal(userId, 'user1', 'userId passed correctly');
        assert.equal(catId, 'opus', 'catId passed correctly');
        assert.equal(threadId, 'thread-1', 'threadId passed correctly');
        return 'msg-latest'; // Caught up — same as latest message
      },
    });

    // Seed a notice — would normally trigger re-invoke, but cursor caught up
    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false, 'seenCursor caught up → no re-invoke');
    assert.equal(result.skipReason, 'cursor_caught_up');
  });

  it('P1-1: seenCursor behind latest message → re-invoke', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-99', threadId: 'thread-1' }]);

    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async () => 'msg-50', // Behind latest
    });

    // Seed a user notice
    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-99',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, true, 'seenCursor behind → re-invoke');
  });

  // --- P1-2: reinvokePrompt is returned when shouldReinvoke=true ---

  it('P1-2: returns reinvokePrompt with sender info when shouldReinvoke=true', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, true);
    assert.ok(result.reinvokePrompt, 'reinvokePrompt should be present');
    assert.ok(result.reinvokePrompt.includes('user'), 'prompt should mention sender');
    assert.ok(result.reinvokePrompt.includes('1'), 'prompt should mention notice count');
    assert.ok(result.reinvokePrompt.includes('list_recent'), 'prompt should instruct to call list_recent');
  });

  it('P1-2: reinvokePrompt is NOT present when shouldReinvoke=false', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub();
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.reinvokePrompt, undefined, 'no prompt when not re-invoking');
  });

  // --- P1-1: getSeenCursor failure is fail-open ---

  it('P1-1: getSeenCursor failure → fail-open (return null, no re-invoke)', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);

    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async () => {
        throw new Error('cursor store unreachable');
      },
    });

    // Seed a user notice — would normally trigger re-invoke, but cursor store error → fail-open
    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    // fail-open: cursor store error → null (no re-invoke, consistent with factory contract)
    assert.equal(result, null, 'getSeenCursor failure → null (fail-open, no re-invoke)');
  });

  // --- GPT52 P1: delivery-order vs ID-order divergence ---

  it('GPT52-P1: late-delivered queued message — cursor filter takes priority (known limitation)', async () => {
    const redis = createRedisStub();

    // Scenario: message 'msg-30' was created at T0 (old ID) but delivered at T2 (new score).
    // Cat has seen up to 'msg-50' (created at T1 where T0 < T1 < T2).
    //
    // With GPT52-R2-P1 cursor filter: notice.maxMessageId('msg-30') < seenCursor('msg-50')
    // → notice filtered out → no unresolved notices → shouldReinvoke=false.
    //
    // Known limitation (matches B2 FreshnessNoticeService.ts:162-170):
    // Late-delivered queued messages have old IDs but new delivery scores.
    // The cursor filter uses ID-based (creation-time) comparison, so it considers
    // msg-30 as "already read past" even though it was delivered after the cursor
    // advanced. This is acceptable for Phase B because:
    //   (a) B1 already delivered the original notice
    //   (b) this is an advisory re-invoke, not a blocking gate
    //   (c) Phase B scope doesn't cover queued-message delivery interactions
    // The score-aware seenCursorCaughtUp (getByThreadAfter) still provides value
    // for the "thread-level caught up" check, independent of notice filtering.
    const lateDeliveredMsg = { id: 'msg-30', threadId: 'thread-1' };
    const messageStore = createMessageStoreStub([lateDeliveredMsg]);

    messageStore.getByThreadAfter = async (_threadId, afterId, _limit) => {
      if (afterId === 'msg-50') return [lateDeliveredMsg];
      return [];
    };

    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async () => 'msg-50',
    });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-30',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    // Cursor filter removes notice (msg-30 < cursor msg-50) → no re-invoke.
    // This is a known limitation for late-delivered messages (B2 parity).
    assert.equal(
      result.shouldReinvoke,
      false,
      'cursor filter removes late-delivered notice (known Phase B limitation)',
    );
  });

  it('GPT52-R2-P1: already-read notice with newer low-priority message → no spurious re-invoke', async () => {
    // Scenario: notice attached for msg-0050 (user, high priority), cat reads to msg-0100,
    // then new msg-0120 arrives from connector (low priority). Without cursor-based notice
    // filtering, the stale high-priority notice on msg-0050 would cause a spurious re-invoke
    // because seenCursorCaughtUp=false (msg-0120 exists after cursor).
    // NOTE: IDs must be zero-padded for correct lexicographic ordering.
    const latestMsg = { id: 'msg-0120', threadId: 'thread-1' };
    const messageStore = createMessageStoreStub([latestMsg]);
    // getByThreadAfter: msg-0120 exists after cursor msg-0100 → not caught up
    messageStore.getByThreadAfter = async (_threadId, afterId, _limit) => {
      if (afterId === 'msg-0100') return [latestMsg];
      return [];
    };

    const redis = createRedisStub();
    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async () => 'msg-0100', // cat has read up to msg-0100
    });

    // Seed a stale notice on msg-0050 (already read past by cursor at msg-0100)
    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-stale',
        unseenSenders: ['user'],
        maxMessageId: 'msg-0050', // < seenCursor msg-0100 → already read
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(
      result.shouldReinvoke,
      false,
      'stale notice (maxMessageId < seenCursor) must not trigger re-invoke even with newer low-priority messages',
    );
  });

  it('GPT52-R2-P1: unread notice with newer messages → still triggers re-invoke', async () => {
    // Counterpart: notice on msg-0150 (AFTER cursor at msg-0100) should still trigger
    const latestMsg = { id: 'msg-0150', threadId: 'thread-1' };
    const messageStore = createMessageStoreStub([latestMsg]);
    messageStore.getByThreadAfter = async (_threadId, afterId, _limit) => {
      if (afterId === 'msg-0100') return [latestMsg];
      return [];
    };

    const redis = createRedisStub();
    const check = createFreshnessReinvokeCheck({
      redis,
      messageStore,
      getSeenCursor: async () => 'msg-0100',
    });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-fresh',
        unseenSenders: ['user'],
        maxMessageId: 'msg-0150', // > seenCursor msg-0100 → NOT read yet
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, true, 'fresh notice (maxMessageId > seenCursor) must still trigger re-invoke');
  });

  it('GPT52-R2-P2: reinvoke_triggered event is recorded in event log', async () => {
    const redis = createRedisStub();
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, true);

    // Verify reinvoke_triggered event was appended
    const events = redis._lists['freshness:events:inv:inv-1'];
    const triggeredEvents = events.map((e) => JSON.parse(e)).filter((e) => e.kind === 'reinvoke_triggered');
    assert.equal(triggeredEvents.length, 1, 'reinvoke_triggered event should be recorded');
    assert.deepEqual(triggeredEvents[0].sourceNoticeIds, ['notice-1']);
    assert.equal(triggeredEvents[0].triggeredInvocationId, 'queued-pending');
  });

  it('GPT52-R2-P2: reinvoke_skipped event is recorded in event log', async () => {
    const redis = createRedisStub({
      'freshness:reinvoke_quota:opus:thread-1': '3', // MAX_REINVOKES_PER_HOUR
    });
    const messageStore = createMessageStoreStub([{ id: 'msg-latest', threadId: 'thread-1' }]);
    const check = createFreshnessReinvokeCheck({ redis, messageStore });

    redis._lists['freshness:events:inv:inv-1'] = [
      JSON.stringify({
        kind: 'notice_attached',
        invocationId: 'inv-1',
        threadId: 'thread-1',
        catId: 'opus',
        timestamp: Date.now(),
        noticeId: 'notice-1',
        unseenSenders: ['user'],
        maxMessageId: 'msg-latest',
      }),
    ];

    const result = await check({
      invocationId: 'inv-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user1',
    });

    assert.ok(result);
    assert.equal(result.shouldReinvoke, false);
    assert.equal(result.skipReason, 'quota_exhausted');

    // Verify reinvoke_skipped event was appended
    const events = redis._lists['freshness:events:inv:inv-1'];
    const skippedEvents = events.map((e) => JSON.parse(e)).filter((e) => e.kind === 'reinvoke_skipped');
    assert.equal(skippedEvents.length, 1, 'reinvoke_skipped event should be recorded');
    assert.equal(skippedEvents[0].reason, 'quota_exhausted');
  });
});
