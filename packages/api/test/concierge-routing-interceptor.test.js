/**
 * F229 P1 fix — ConciergeRoutingInterceptor unit tests
 *
 * Verifies prepareConciergeContext returns the right shape for concierge threads
 * and is a no-op for normal threads / missing store.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Dynamic import so we can test ESM with --test
const { prepareConciergeContext, conciergeContextForCat } = await import(
  '../dist/domains/concierge/ConciergeRoutingInterceptor.js'
);

const MOCK_CONFIG = {
  enabled: true,
  skin: 'ragdoll-v1',
  displayName: '猫猫球',
  personaTone: '温暖、简短',
  dutyCatProfileId: 'gemini35',
  proactivePolicy: 'quiet-badge',
  muted: false,
};

const mockStore = {
  get: async (_userId) => MOCK_CONFIG,
  put: async () => {},
};

describe('prepareConciergeContext', () => {
  it('returns empty object when thread is null', async () => {
    const result = await prepareConciergeContext(null, 'user-1', mockStore);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when thread has no threadKind', async () => {
    const thread = { id: 'thread-1', userId: 'user-1' };
    const result = await prepareConciergeContext(thread, 'user-1', mockStore);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when thread is a different kind', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'other' };
    const result = await prepareConciergeContext(thread, 'user-1', mockStore);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when store is undefined', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'concierge' };
    const result = await prepareConciergeContext(thread, 'user-1', undefined);
    assert.deepStrictEqual(result, {});
  });

  it('returns threadKind + conciergeConfig when thread.threadKind === concierge and store is provided', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'concierge' };
    const result = await prepareConciergeContext(thread, 'user-1', mockStore);
    assert.strictEqual(result.threadKind, 'concierge');
    assert.deepStrictEqual(result.conciergeConfig, MOCK_CONFIG);
  });

  it('calls store.get with the provided userId', async () => {
    let capturedUserId = null;
    const capturingStore = {
      get: async (userId) => {
        capturedUserId = userId;
        return MOCK_CONFIG;
      },
      put: async () => {},
    };
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'concierge' };
    await prepareConciergeContext(thread, 'captured-user', capturingStore);
    assert.strictEqual(capturedUserId, 'captured-user');
  });
});

describe('conciergeContextForCat', () => {
  const ctx = {
    threadKind: 'concierge',
    conciergeConfig: { ...MOCK_CONFIG, dutyCatProfileId: 'gemini35' },
  };
  const emptyCtx = {};

  it('returns empty when ctx has no conciergeConfig (normal thread)', () => {
    assert.deepStrictEqual(conciergeContextForCat(emptyCtx, 'gemini35'), {});
  });

  it('returns full ctx when catId matches dutyCatProfileId', () => {
    const result = conciergeContextForCat(ctx, 'gemini35');
    assert.strictEqual(result.threadKind, 'concierge');
    assert.deepStrictEqual(result.conciergeConfig, ctx.conciergeConfig);
  });

  it('returns empty when catId does NOT match dutyCatProfileId', () => {
    assert.deepStrictEqual(conciergeContextForCat(ctx, 'opus47'), {});
  });

  it('returns empty when catId is empty string', () => {
    assert.deepStrictEqual(conciergeContextForCat(ctx, ''), {});
  });
});
