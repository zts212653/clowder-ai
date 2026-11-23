/**
 * F229 P1 fix — ConciergeRoutingInterceptor unit tests
 *
 * Verifies prepareConciergeContext returns the right shape for concierge threads
 * and is a no-op for normal threads / a missing settings reader.
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
  behaviorEnabled: true,
  ballSize: 72,
};

const readSettings = async () => MOCK_CONFIG;

describe('prepareConciergeContext', () => {
  it('returns empty object when thread is null', async () => {
    const result = await prepareConciergeContext(null, readSettings);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when thread has no threadKind', async () => {
    const thread = { id: 'thread-1', userId: 'user-1' };
    const result = await prepareConciergeContext(thread, readSettings);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when thread is a different kind', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'other' };
    const result = await prepareConciergeContext(thread, readSettings);
    assert.deepStrictEqual(result, {});
  });

  it('returns empty object when no settings reader is provided', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'concierge' };
    const result = await prepareConciergeContext(thread, undefined);
    assert.deepStrictEqual(result, {});
  });

  it('returns threadKind + conciergeConfig when thread.threadKind === concierge and settings are readable', async () => {
    const thread = { id: 'thread-1', userId: 'user-1', threadKind: 'concierge' };
    const result = await prepareConciergeContext(thread, readSettings);
    assert.strictEqual(result.threadKind, 'concierge');
    assert.deepStrictEqual(result.conciergeConfig, MOCK_CONFIG);
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
