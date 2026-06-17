/**
 * RedisConciergeConfigStore tests (F229 PR-A1)
 * 有 Redis → 测全量；无 Redis → skip
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

// gemini35 lives in the runtime catalog overlay (not cat-template.json).
// Register it for tests so resolveDefaultDutyCatProfileId() finds the expected default.
if (!catRegistry.has('gemini35')) {
  catRegistry.register('gemini35', {
    id: 'gemini35',
    name: '暹罗猫 Gemini 3.5 Flash',
    displayName: '暹罗猫',
    avatar: '/avatars/gemini25.png',
    color: { primary: '#2563EB', secondary: '#DBEAFE' },
    mentionPatterns: ['@gemini35'],
    clientId: 'google',
    defaultModel: 'Gemini 3.5 Flash (High)',
    mcpSupport: true,
    roleDescription: '暹罗猫 Gemini 3.5 Flash',
    personality: '创意灵感丰富',
  });
}

import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisConciergeConfigStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisConciergeConfigStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisConciergeConfigStore');

    const storeModule = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    RedisConciergeConfigStore = storeModule.RedisConciergeConfigStore;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-concierge-config.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisConciergeConfigStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['concierge:config:*', 'concierge:thread:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['concierge:config:*']);
  });

  it('get returns defaults when no config stored', async () => {
    const config = await store.get('user-1');
    assert.equal(config.enabled, true);
    assert.equal(config.skin, 'ragdoll-v1');
    assert.equal(config.displayName, '猫猫球');
    assert.equal(config.personaTone, '温暖、简短、不啰嗦');
    assert.equal(config.proactivePolicy, 'quiet-badge');
    assert.equal(config.muted, false);
    // dutyCatProfileId default: 'gemini35' (暹罗猫 Gemini 3.5 Flash) if in roster, else first available
    assert.ok(typeof config.dutyCatProfileId === 'string' && config.dutyCatProfileId.length > 0);
  });

  it('put persists config and get returns it (round-trip)', async () => {
    const input = {
      enabled: false,
      skin: 'ragdoll-v1',
      displayName: 'KittyDesk',
      personaTone: '简洁',
      dutyCatProfileId: 'gpt52',
      proactivePolicy: 'ambient',
      muted: true,
    };
    await store.put('user-2', input);
    const retrieved = await store.get('user-2');
    assert.equal(retrieved.enabled, false);
    assert.equal(retrieved.displayName, 'KittyDesk');
    assert.equal(retrieved.dutyCatProfileId, 'gpt52');
    assert.equal(retrieved.proactivePolicy, 'ambient');
    assert.equal(retrieved.muted, true);
  });

  it('put is idempotent — second put overwrites first', async () => {
    await store.put('user-3', {
      enabled: true,
      skin: 'ragdoll-v1',
      displayName: 'First',
      personaTone: 'test',
      dutyCatProfileId: 'sonnet',
      proactivePolicy: 'quiet-badge',
      muted: false,
    });
    await store.put('user-3', {
      enabled: false,
      skin: 'ragdoll-v1',
      displayName: 'Second',
      personaTone: 'test2',
      dutyCatProfileId: 'codex',
      proactivePolicy: 'ambient',
      muted: true,
    });
    const config = await store.get('user-3');
    assert.equal(config.displayName, 'Second');
    assert.equal(config.dutyCatProfileId, 'codex');
    assert.equal(config.enabled, false);
  });

  it('config is stored with TTL=0 (persistent, no expiry)', async () => {
    await store.put('user-4', {
      enabled: true,
      skin: 'ragdoll-v1',
      displayName: 'NeverExpire',
      personaTone: 'test',
      dutyCatProfileId: 'sonnet',
      proactivePolicy: 'quiet-badge',
      muted: false,
    });
    // ioredis keyPrefix auto-applies; TTL=-1 means persistent
    const prefix = redis.options.keyPrefix ?? '';
    const ttl = await redis.ttl(`${prefix}concierge:config:user-4`);
    // Strip prefix before calling ttl (which auto-adds prefix)
    const ttlDirect = await redis.ttl('concierge:config:user-4');
    // Either approach: TTL should be -1 (persistent)
    assert.ok(ttlDirect === -1 || ttl === -1, `expected TTL=-1, got direct=${ttlDirect} prefixed=${ttl}`);
  });

  it('different users have independent configs', async () => {
    await store.put('user-a', {
      enabled: true,
      skin: 'ragdoll-v1',
      displayName: 'Alice',
      personaTone: 'warm',
      dutyCatProfileId: 'gemini35',
      proactivePolicy: 'quiet-badge',
      muted: false,
    });
    await store.put('user-b', {
      enabled: false,
      skin: 'ragdoll-v1',
      displayName: 'Bob',
      personaTone: 'brief',
      dutyCatProfileId: 'sonnet',
      proactivePolicy: 'ambient',
      muted: true,
    });
    const a = await store.get('user-a');
    const b = await store.get('user-b');
    assert.equal(a.displayName, 'Alice');
    assert.equal(b.displayName, 'Bob');
    assert.equal(a.muted, false);
    assert.equal(b.muted, true);
  });
});
