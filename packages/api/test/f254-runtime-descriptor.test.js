/**
 * F254 Phase C — RuntimeCapabilityDescriptor tests
 *
 * TDD: RED first. Tests for:
 * - AC-C1: descriptorFromDriver derives descriptor from (provider, carrierTier)
 * - AC-C3: checkFreshnessForPostMessage honors canReceiveHeldResponse
 * - AC-C3: FreshnessNoticeService.checkAndMaybeNotice honors canReceiveContentFreeNotice
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// --- AC-C1: Descriptor derivation ---

describe('RuntimeCapabilityDescriptor (AC-C1)', () => {
  describe('descriptorFromDriver', () => {
    it('returns full capabilities for interactive_pty + anthropic', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('anthropic', 'interactive_pty');
      assert.equal(d.carrier, 'interactive');
      assert.equal(d.driver, 'anthropic');
      assert.equal(d.canReceiveHeldResponse, true);
      assert.equal(d.canReceiveContentFreeNotice, true);
      assert.equal(d.canAskHumanSync, true);
      assert.equal(d.backgroundBashReliable, true);
    });

    it('returns full capabilities for print_sdk + anthropic (headless -p)', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('anthropic', 'print_sdk');
      assert.equal(d.carrier, 'headless-p');
      assert.equal(d.driver, 'anthropic');
      assert.equal(d.canReceiveHeldResponse, true);
      assert.equal(d.canReceiveContentFreeNotice, true);
      // headless -p has no human to ask
      assert.equal(d.canAskHumanSync, false);
    });

    it('returns restricted capabilities for bg_daemon', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('anthropic', 'bg_daemon');
      assert.equal(d.carrier, 'bg-cron');
      assert.equal(d.canReceiveHeldResponse, false);
      assert.equal(d.canReceiveContentFreeNotice, false);
      assert.equal(d.canAskHumanSync, false);
    });

    it('returns cloud descriptor for api_key + openai (cloud codex)', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('openai', 'api_key');
      assert.equal(d.carrier, 'cloud');
      assert.equal(d.driver, 'openai');
      // Cloud codex is async — no interactive freshness
      assert.equal(d.canReceiveHeldResponse, false);
      assert.equal(d.canReceiveContentFreeNotice, false);
    });

    it('returns default (permissive) for unknown provider + api_key', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('unknown-provider', 'api_key');
      assert.equal(d.carrier, 'cloud');
      assert.equal(d.driver, 'unknown-provider');
      // Unknown defaults to permissive (fail-open)
      assert.equal(d.canReceiveHeldResponse, true);
      assert.equal(d.canReceiveContentFreeNotice, true);
    });

    it('returns google/gemini descriptor for google + print_sdk', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('google', 'print_sdk');
      assert.equal(d.carrier, 'headless-p');
      assert.equal(d.driver, 'google');
      assert.equal(d.canReceiveHeldResponse, true);
      assert.equal(d.canReceiveContentFreeNotice, true);
    });

    it('maps unknown carrier tier to headless-p (same as resolveTargetTier default)', async () => {
      const { descriptorFromDriver } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromDriver('anthropic', 'unknown_tier');
      assert.equal(d.carrier, 'headless-p');
      assert.equal(d.canReceiveHeldResponse, true);
    });
  });

  describe('DEFAULT_DESCRIPTOR', () => {
    it('is fully permissive (fail-open when no descriptor available)', async () => {
      const { DEFAULT_DESCRIPTOR } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      assert.equal(DEFAULT_DESCRIPTOR.canReceiveHeldResponse, true);
      assert.equal(DEFAULT_DESCRIPTOR.canReceiveContentFreeNotice, true);
      assert.equal(DEFAULT_DESCRIPTOR.canAskHumanSync, false);
    });
  });

  describe('carrierTierToCarrierName', () => {
    it('maps all known carrier tiers', async () => {
      const { carrierTierToCarrierName } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      assert.equal(carrierTierToCarrierName('interactive_pty'), 'interactive');
      assert.equal(carrierTierToCarrierName('print_sdk'), 'headless-p');
      assert.equal(carrierTierToCarrierName('bg_daemon'), 'bg-cron');
      assert.equal(carrierTierToCarrierName('api_key'), 'cloud');
    });
  });

  describe('descriptorFromProviderFallback (gpt52 terminal review P1)', () => {
    it('returns restricted descriptor for openai (ASYNC_CLOUD_PROVIDERS)', async () => {
      const { descriptorFromProviderFallback } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromProviderFallback('openai');
      assert.notEqual(d, undefined, 'openai should get a descriptor, not undefined');
      assert.equal(d.carrier, 'cloud');
      assert.equal(d.driver, 'openai');
      assert.equal(d.canReceiveHeldResponse, false, 'openai should NOT receive held responses');
      assert.equal(d.canReceiveContentFreeNotice, false, 'openai should NOT receive notices');
    });

    it('returns undefined for non-async providers (google, kimi, antigravity)', async () => {
      const { descriptorFromProviderFallback } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      assert.equal(descriptorFromProviderFallback('google'), undefined);
      assert.equal(descriptorFromProviderFallback('kimi'), undefined);
      assert.equal(descriptorFromProviderFallback('antigravity'), undefined);
      assert.equal(descriptorFromProviderFallback('anthropic'), undefined);
      assert.equal(descriptorFromProviderFallback('unknown'), undefined);
    });
  });
});

// --- AC-C3: Gate behavior parameterized by descriptor ---

describe('checkFreshnessForPostMessage with descriptor (AC-C3)', () => {
  it('returns warning-forward instead of held when canReceiveHeldResponse=false', async () => {
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );

    // Stub stores: seenCursor exists but is behind (would normally hold)
    const cursorStore = {
      getSeenCursor: async () => 'msg-001',
      pushSeenCursor: async () => {},
    };
    const messageStore = {
      getByThreadAfter: async () => [{ id: 'msg-002', catId: null, content: 'Hello from user' }],
    };

    const result = await checkFreshnessForPostMessage({
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      toolName: 'post_message',
      cursorStore,
      messageStore,
      descriptor: {
        carrier: 'bg-cron',
        driver: 'anthropic',
        canReceiveHeldResponse: false,
        canReceiveContentFreeNotice: false,
        busyDeliveryMode: 'direct',
        canAskHumanSync: false,
        backgroundBashReliable: false,
        permissionMode: 'none',
      },
    });

    // Should forward with a warning, not hold
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'descriptor_no_held');
    assert.ok(result.unseenCount > 0);
  });

  it('still holds when canReceiveHeldResponse=true (existing behavior)', async () => {
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );

    const cursorStore = {
      getSeenCursor: async () => 'msg-001',
      pushSeenCursor: async () => {},
    };
    const messageStore = {
      getByThreadAfter: async () => [{ id: 'msg-002', catId: null, content: 'Hello from user' }],
    };

    const result = await checkFreshnessForPostMessage({
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      toolName: 'post_message',
      cursorStore,
      messageStore,
      descriptor: {
        carrier: 'interactive',
        driver: 'anthropic',
        canReceiveHeldResponse: true,
        canReceiveContentFreeNotice: true,
        busyDeliveryMode: 'gated',
        canAskHumanSync: true,
        backgroundBashReliable: true,
        permissionMode: 'default',
      },
    });

    assert.equal(result.decision, 'held');
  });

  it('preserves existing behavior when no descriptor provided (backward compat)', async () => {
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );

    const cursorStore = {
      getSeenCursor: async () => 'msg-001',
      pushSeenCursor: async () => {},
    };
    const messageStore = {
      getByThreadAfter: async () => [{ id: 'msg-002', catId: null, content: 'Hello from user' }],
    };

    const result = await checkFreshnessForPostMessage({
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      toolName: 'post_message',
      cursorStore,
      messageStore,
      // No descriptor — should behave as before
    });

    assert.equal(result.decision, 'held');
  });

  it('applies descriptor override to pagination_limit_uncertain held path (cloud P2 fix)', async () => {
    const { checkFreshnessForPostMessage } = await import(
      '../dist/domains/cats/services/freshness/checkFreshnessForPostMessage.js'
    );

    // Generate exactly 20 self-messages per batch (= UNSEEN_FETCH_LIMIT)
    // so thread is never exhausted within MAX_PAGINATION_ROUNDS (5).
    // After 5 rounds of 20 self-messages, the loop exits with threadExhausted=false.
    // Gate sees all self-messages → returns 'all_self_messages'.
    // Line 274: all_self + !threadExhausted → paginationHeldResult with 'pagination_limit_uncertain'.
    const selfMessages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-self-${i}`,
      catId: 'opus',
      content: `Self message ${i}`,
    }));

    const cursorStore = {
      getSeenCursor: async () => 'msg-000',
      pushSeenCursor: async () => {},
    };
    const messageStore = {
      getByThreadAfter: async () => [...selfMessages], // Always returns 20 self-messages
    };

    const result = await checkFreshnessForPostMessage({
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      toolName: 'post_message',
      cursorStore,
      messageStore,
      descriptor: {
        carrier: 'bg-cron',
        driver: 'anthropic',
        canReceiveHeldResponse: false,
        canReceiveContentFreeNotice: false,
        busyDeliveryMode: 'direct',
        canAskHumanSync: false,
        backgroundBashReliable: false,
        permissionMode: 'none',
      },
    });

    // Before the fix, this returned {decision: 'held'} even with canReceiveHeldResponse=false.
    // After the fix, applyDescriptorOverride converts it to forward-with-warning.
    assert.equal(result.decision, 'forward');
    assert.equal(result.reason, 'descriptor_no_held');
  });
});

// --- AC-C3: Notice behavior parameterized by descriptor ---

describe('FreshnessNoticeService with descriptor (AC-C3)', () => {
  it('returns null when canReceiveContentFreeNotice=false', async () => {
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    const stateStore = {
      get: async () => ({
        toolCallCount: 5,
        noticeDeliveredCount: 0,
        lastNoticeToolCallNum: 0,
        ackedNoticeIds: [],
        reinvokeTriggered: false,
      }),
      incrementToolCallCount: async () => 5,
      recordNoticeDelivered: async () => {},
    };
    const eventLog = {
      append: async () => {},
      getUnresolvedNotices: async () => [],
    };
    const unseenChecker = {
      checkUnseen: async () => ({ count: 3, senders: ['user'], maxMessageId: 'msg-100' }),
    };

    const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
    const result = await service.checkAndMaybeNotice({
      invocationId: 'inv-1',
      threadId: 't1',
      catId: 'opus',
      toolName: 'get_thread_context',
      isReadOnly: true,
      descriptor: {
        carrier: 'bg-cron',
        driver: 'anthropic',
        canReceiveHeldResponse: false,
        canReceiveContentFreeNotice: false,
        busyDeliveryMode: 'direct',
        canAskHumanSync: false,
        backgroundBashReliable: false,
        permissionMode: 'none',
      },
    });

    assert.equal(result, null);
  });

  it('returns notice when canReceiveContentFreeNotice=true', async () => {
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    const stateStore = {
      get: async () => ({
        toolCallCount: 5,
        noticeDeliveredCount: 0,
        lastNoticeToolCallNum: 0,
        ackedNoticeIds: [],
        reinvokeTriggered: false,
      }),
      incrementToolCallCount: async () => 5,
      recordNoticeDelivered: async () => {},
    };
    const eventLog = {
      append: async () => {},
      getUnresolvedNotices: async () => [],
    };
    const unseenChecker = {
      checkUnseen: async () => ({ count: 3, senders: ['user'], maxMessageId: 'msg-100' }),
    };

    const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
    const result = await service.checkAndMaybeNotice({
      invocationId: 'inv-1',
      threadId: 't1',
      catId: 'opus',
      toolName: 'get_thread_context',
      isReadOnly: true,
      descriptor: {
        carrier: 'interactive',
        driver: 'anthropic',
        canReceiveHeldResponse: true,
        canReceiveContentFreeNotice: true,
        busyDeliveryMode: 'gated',
        canAskHumanSync: true,
        backgroundBashReliable: true,
        permissionMode: 'default',
      },
    });

    assert.notEqual(result, null);
    assert.ok(result?.text.includes('未读消息'));
  });

  it('preserves existing behavior when no descriptor provided', async () => {
    const { FreshnessNoticeService } = await import(
      '../dist/domains/cats/services/freshness/FreshnessNoticeService.js'
    );

    const stateStore = {
      get: async () => ({
        toolCallCount: 5,
        noticeDeliveredCount: 0,
        lastNoticeToolCallNum: 0,
        ackedNoticeIds: [],
        reinvokeTriggered: false,
      }),
      incrementToolCallCount: async () => 5,
      recordNoticeDelivered: async () => {},
    };
    const eventLog = {
      append: async () => {},
      getUnresolvedNotices: async () => [],
    };
    const unseenChecker = {
      checkUnseen: async () => ({ count: 3, senders: ['user'], maxMessageId: 'msg-100' }),
    };

    const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);
    const result = await service.checkAndMaybeNotice({
      invocationId: 'inv-1',
      threadId: 't1',
      catId: 'opus',
      toolName: 'get_thread_context',
      isReadOnly: true,
      // No descriptor — should behave as before (deliver notice)
    });

    assert.notEqual(result, null);
  });
});

// --- AC-C2: carrierTier stored in FreshnessInvocationStateStore ---

describe('FreshnessInvocationStateStore carrierTier (AC-C2)', () => {
  it('setCarrierTier stores the tier and get() returns it', async () => {
    const { FreshnessInvocationStateStore } = await import(
      '../dist/domains/cats/services/freshness/FreshnessInvocationStateStore.js'
    );

    // Minimal Redis stub — only needs hgetall, hsetnx, expire
    const store = {};
    const redis = {
      hgetall: async (key) => store[key] || {},
      hsetnx: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        if (!(field in store[key])) {
          store[key][field] = value;
          return 1;
        }
        return 0;
      },
      hset: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        store[key][field] = value;
      },
      hincrby: async (key, field, incr) => {
        if (!store[key]) store[key] = {};
        const cur = parseInt(store[key][field] || '0', 10);
        store[key][field] = String(cur + incr);
        return cur + incr;
      },
      expire: async () => {},
    };

    const stateStore = new FreshnessInvocationStateStore(redis);

    // Initially no state
    const before = await stateStore.get('inv-1');
    assert.equal(before, null);

    // Init state (creates the hash)
    await stateStore.incrementToolCallCount('inv-1');

    // Set carrier tier
    await stateStore.setCarrierTier('inv-1', 'interactive_pty');

    // Read it back
    const after = await stateStore.get('inv-1');
    assert.equal(after.carrierTier, 'interactive_pty');
    assert.equal(after.toolCallCount, 1);
  });

  it('setCarrierTier is idempotent (HSETNX — does not overwrite)', async () => {
    const { FreshnessInvocationStateStore } = await import(
      '../dist/domains/cats/services/freshness/FreshnessInvocationStateStore.js'
    );

    const store = {};
    const redis = {
      hgetall: async (key) => store[key] || {},
      hsetnx: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        if (!(field in store[key])) {
          store[key][field] = value;
          return 1;
        }
        return 0;
      },
      hset: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        store[key][field] = value;
      },
      hincrby: async (key, field, incr) => {
        if (!store[key]) store[key] = {};
        const cur = parseInt(store[key][field] || '0', 10);
        store[key][field] = String(cur + incr);
        return cur + incr;
      },
      expire: async () => {},
    };

    const stateStore = new FreshnessInvocationStateStore(redis);
    await stateStore.incrementToolCallCount('inv-2');

    // First set
    await stateStore.setCarrierTier('inv-2', 'bg_daemon');
    // Second set (should not overwrite)
    await stateStore.setCarrierTier('inv-2', 'interactive_pty');

    const state = await stateStore.get('inv-2');
    assert.equal(state.carrierTier, 'bg_daemon'); // First value preserved
  });

  it('get() returns undefined carrierTier when not set', async () => {
    const { FreshnessInvocationStateStore } = await import(
      '../dist/domains/cats/services/freshness/FreshnessInvocationStateStore.js'
    );

    const store = {};
    const redis = {
      hgetall: async (key) => store[key] || {},
      hsetnx: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        if (!(field in store[key])) {
          store[key][field] = value;
          return 1;
        }
        return 0;
      },
      hset: async (key, field, value) => {
        if (!store[key]) store[key] = {};
        store[key][field] = value;
      },
      hincrby: async (key, field, incr) => {
        if (!store[key]) store[key] = {};
        const cur = parseInt(store[key][field] || '0', 10);
        store[key][field] = String(cur + incr);
        return cur + incr;
      },
      expire: async () => {},
    };

    const stateStore = new FreshnessInvocationStateStore(redis);
    await stateStore.incrementToolCallCount('inv-3');

    const state = await stateStore.get('inv-3');
    assert.equal(state.carrierTier, undefined);
  });
});
