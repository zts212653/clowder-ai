/**
 * F204: Generic PluginTokenManager cache resilience tests
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { PluginTokenManager } from '../dist/domains/limb/PluginTokenManager.js';

const originalFetch = globalThis.fetch;

const AUTH_CONFIG = {
  type: 'client_credentials',
  tokenEndpoint: 'https://api.example.com/token',
  tokenParams: {
    grant_type: 'client_credential',
    appid: '${APP_ID}',
    secret: '${APP_SECRET}',
  },
  tokenResponsePath: 'access_token',
  tokenPlacement: 'query',
  tokenParamName: 'access_token',
  tokenExpiredCodes: [40001, 40014, 42001],
  ttlSeconds: 7200,
};

function tokenResponse(token) {
  return {
    ok: true,
    json: async () => ({ access_token: token, expires_in: 7200 }),
  };
}

function createManager(redis, config) {
  return new PluginTokenManager(AUTH_CONFIG, 'https://api.example.com', config, redis);
}

describe('PluginTokenManager Redis cache resilience', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('falls back to a fresh token when Redis read fails', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return tokenResponse('fresh-token');
    };

    const redis = {
      get: async () => {
        throw new Error('redis unavailable');
      },
      setex: async () => undefined,
    };
    const manager = createManager(redis, { APP_ID: 'appid', APP_SECRET: 'secret' });

    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(fetchCalls, 1);
  });

  it('keeps the in-memory token when Redis write fails', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return tokenResponse('fresh-token');
    };

    const redis = {
      get: async () => null,
      setex: async () => {
        throw new Error('redis unavailable');
      },
    };
    const manager = createManager(redis, { APP_ID: 'appid', APP_SECRET: 'secret' });

    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(fetchCalls, 1);
  });

  it('primes the in-memory fallback cache from Redis hits', async () => {
    globalThis.fetch = async () => {
      throw new Error('should not refresh when Redis fallback cache is primed');
    };

    let redisAvailable = true;
    const redis = {
      get: async () => {
        if (!redisAvailable) throw new Error('redis unavailable');
        return 'redis-token';
      },
      setex: async () => undefined,
    };
    const manager = createManager(redis, { APP_ID: 'appid', APP_SECRET: 'secret' });

    assert.equal(await manager.getAccessToken(), 'redis-token');
    redisAvailable = false;
    assert.equal(await manager.getAccessToken(), 'redis-token');
  });

  it('clears Redis and in-memory fallback tokens when invalidated', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return tokenResponse('fresh-token');
    };

    let cached = 'redis-token';
    let deletedKey = null;
    const redis = {
      get: async () => cached,
      setex: async (_key, _ttl, token) => {
        cached = token;
      },
      del: async (key) => {
        deletedKey = key;
        cached = null;
      },
    };
    const manager = createManager(redis, { APP_ID: 'appid', APP_SECRET: 'secret' });

    assert.equal(await manager.getAccessToken(), 'redis-token');
    await manager.invalidateAccessToken();
    assert.ok(deletedKey?.startsWith('plugin-limb:token:'));
    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(fetchCalls, 1);
  });

  it('bypasses Redis once after invalidation when Redis delete fails', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return tokenResponse('fresh-token');
    };

    let cached = 'stale-token';
    const redis = {
      get: async () => cached,
      setex: async (_key, _ttl, token) => {
        cached = token;
      },
      del: async () => {
        throw new Error('redis delete denied');
      },
    };
    const manager = createManager(redis, { APP_ID: 'appid', APP_SECRET: 'secret' });

    assert.equal(await manager.getAccessToken(), 'stale-token');
    await manager.invalidateAccessToken();
    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(fetchCalls, 1);
    assert.equal(cached, 'fresh-token');
  });

  it('resolves template variables from plugin config', () => {
    const manager = createManager(undefined, { APP_ID: 'my-app-id', APP_SECRET: 'my-secret' });
    assert.equal(manager.resolveTemplate('${APP_ID}'), 'my-app-id');
    assert.equal(manager.resolveTemplate('prefix-${APP_SECRET}-suffix'), 'prefix-my-secret-suffix');
  });

  it('detects token expired error codes from auth config', () => {
    const manager = createManager(undefined, { APP_ID: 'id', APP_SECRET: 'secret' });
    assert.ok(manager.isTokenExpiredError(40001));
    assert.ok(manager.isTokenExpiredError(42001));
    assert.ok(!manager.isTokenExpiredError(99999));
  });
});
