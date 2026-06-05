/**
 * F204: WeChat MP token cache resilience tests
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { WeixinMpTokenManager } from '../dist/domains/weixin-mp/weixin-mp-token.js';

const originalFetch = globalThis.fetch;

function tokenResponse(token) {
  return {
    json: async () => ({ access_token: token, expires_in: 7200 }),
  };
}

describe('WeixinMpTokenManager Redis cache resilience', () => {
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
    const manager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'secret',
    });

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
    const manager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'secret',
    });

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
    const manager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'secret',
    });

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
    const manager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'secret',
    });

    assert.equal(await manager.getAccessToken(), 'redis-token');
    await manager.invalidateAccessToken();
    assert.match(deletedKey, /^weixin-mp:access-token:appid:[0-9a-f]{16}$/);
    assert.ok(!deletedKey.includes('secret'), 'Redis token key must not expose the AppSecret');
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
    const manager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'secret',
    });

    assert.equal(await manager.getAccessToken(), 'stale-token');
    await manager.invalidateAccessToken();
    assert.equal(await manager.getAccessToken(), 'fresh-token');
    assert.equal(fetchCalls, 1);
    assert.equal(cached, 'fresh-token');
  });

  it('refreshes the in-memory token when the AppSecret changes', async () => {
    const secrets = [];
    globalThis.fetch = async (url) => {
      const secret = new URL(String(url)).searchParams.get('secret');
      secrets.push(secret);
      return tokenResponse(`${secret}-token`);
    };

    const redis = {
      get: async () => null,
      setex: async () => undefined,
    };
    const config = {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'old-secret',
    };
    const manager = new WeixinMpTokenManager(redis, config);

    assert.equal(await manager.getAccessToken(), 'old-secret-token');
    config.WEIXIN_MP_APP_SECRET = 'new-secret';
    assert.equal(await manager.getAccessToken(), 'new-secret-token');
    assert.deepEqual(secrets, ['old-secret', 'new-secret']);
  });

  it('does not reuse Redis tokens written for a previous AppSecret', async () => {
    const cachedTokens = new Map();
    const secrets = [];
    globalThis.fetch = async (url) => {
      const secret = new URL(String(url)).searchParams.get('secret');
      secrets.push(secret);
      return tokenResponse(`${secret}-token`);
    };

    const redis = {
      get: async (key) => cachedTokens.get(key) ?? null,
      setex: async (key, _ttl, token) => {
        cachedTokens.set(key, token);
      },
    };

    const oldManager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'old-secret',
    });
    assert.equal(await oldManager.getAccessToken(), 'old-secret-token');

    const newManager = new WeixinMpTokenManager(redis, {
      WEIXIN_MP_APP_ID: 'appid',
      WEIXIN_MP_APP_SECRET: 'new-secret',
    });
    assert.equal(await newManager.getAccessToken(), 'new-secret-token');
    assert.deepEqual(secrets, ['old-secret', 'new-secret']);
  });
});
