/**
 * F254 Phase C — RuntimeCapabilityDescriptor tests
 *
 * - AC-C1: descriptorFromDriver derives descriptor from (provider, carrierTier)
 * - AC-C2: carrierTier round-trips through FreshnessInvocationStateStore
 *
 * The descriptor's held-response and content-free-notice consumers were the
 * post-message gate and the MCP notice service; both are retired, so what the
 * descriptor still governs is the provider-native carrier truth below.
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
    it('prefers explicit provider over clientId for cloud-only runtime descriptor lookup', async () => {
      const { descriptorFromProviderFallback, resolveFreshnessDescriptorProvider } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );

      const provider = resolveFreshnessDescriptorProvider({
        clientId: 'openai',
        provider: 'openai-chatgpt-pro',
      });
      assert.equal(provider, 'openai-chatgpt-pro');

      const d = descriptorFromProviderFallback(provider);
      assert.notEqual(d, undefined, 'cloud-only runtime must remain restricted when clientId is openai');
      assert.equal(d.carrier, 'cloud');
      assert.equal(d.driver, 'openai-chatgpt-pro');
      assert.equal(d.canReceiveHeldResponse, false);
      assert.equal(d.canReceiveContentFreeNotice, false);
    });

    it('falls back to clientId when no explicit provider exists', async () => {
      const { resolveFreshnessDescriptorProvider } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );

      assert.equal(resolveFreshnessDescriptorProvider({ clientId: 'openai' }), 'openai');
      assert.equal(resolveFreshnessDescriptorProvider(undefined), 'unknown');
    });

    it('returns undefined for regular openai so local Codex stays fail-open without carrierTier', async () => {
      const { descriptorFromProviderFallback } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      assert.equal(descriptorFromProviderFallback('openai'), undefined);
    });

    it('returns restricted descriptor for openai-chatgpt-pro cloud-only provider', async () => {
      const { descriptorFromProviderFallback } = await import(
        '../dist/domains/cats/services/freshness/RuntimeCapabilityDescriptor.js'
      );
      const d = descriptorFromProviderFallback('openai-chatgpt-pro');
      assert.notEqual(d, undefined, 'openai-chatgpt-pro should get a descriptor, not undefined');
      assert.equal(d.carrier, 'cloud');
      assert.equal(d.driver, 'openai-chatgpt-pro');
      assert.equal(d.canReceiveHeldResponse, false, 'cloud-only provider should NOT receive held responses');
      assert.equal(d.canReceiveContentFreeNotice, false, 'cloud-only provider should NOT receive notices');
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
