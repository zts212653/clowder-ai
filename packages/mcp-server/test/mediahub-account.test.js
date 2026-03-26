/**
 * MediaHub — Account Manager Tests
 * F139 Phase B: Credential encryption, CRUD, tools, auto-activation.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

// ==================== Mock Redis ==================

function createMockRedis() {
  const data = new Map();
  const sortedSets = new Map();
  return {
    async hset(key, obj) {
      data.set(key, { ...(data.get(key) ?? {}), ...obj });
      return Object.keys(obj).length;
    },
    async hgetall(key) {
      return data.get(key) ?? {};
    },
    async expire() {
      return 1;
    },
    async zadd(key, ...args) {
      const set = sortedSets.get(key) ?? [];
      for (let i = 0; i < args.length; i += 2) {
        const score = Number(args[i]);
        const member = String(args[i + 1]);
        const idx = set.findIndex((e) => e.member === member);
        if (idx >= 0) set[idx].score = score;
        else set.push({ score, member });
      }
      set.sort((a, b) => b.score - a.score);
      sortedSets.set(key, set);
      return args.length / 2;
    },
    async zrevrangebyscore(key, _max, _min, ...args) {
      const set = sortedSets.get(key) ?? [];
      let limit = set.length;
      const li = args.indexOf('LIMIT');
      if (li >= 0 && args[li + 2]) limit = Number(args[li + 2]);
      return set.slice(0, limit).map((e) => e.member);
    },
    async del(key) {
      data.delete(key);
      return 1;
    },
  };
}

// ==================== AccountManager Tests ==================

describe('AccountManager', () => {
  const TEST_KEY = randomBytes(32);

  async function buildManager() {
    const { AccountManager } = await import('../dist/mediahub/account-manager.js');
    const redis = createMockRedis();
    return new AccountManager(redis, TEST_KEY);
  }

  it('rejects invalid key length', async () => {
    const { AccountManager } = await import('../dist/mediahub/account-manager.js');
    assert.throws(() => new AccountManager(createMockRedis(), Buffer.alloc(16)), /32 bytes/);
  });

  it('saves and retrieves encrypted credentials', async () => {
    const manager = await buildManager();
    await manager.saveCredential('kling', 'api_key', { accessKey: 'ak-123', secretKey: 'sk-456' });
    const data = await manager.getCredentialData('kling');
    assert.ok(data);
    assert.equal(data.accessKey, 'ak-123');
    assert.equal(data.secretKey, 'sk-456');
  });

  it('returns null for non-existent credential', async () => {
    const manager = await buildManager();
    const data = await manager.getCredentialData('nonexistent');
    assert.equal(data, null);
  });

  it('overwrites existing credentials', async () => {
    const manager = await buildManager();
    await manager.saveCredential('kling', 'api_key', { accessKey: 'old' });
    await manager.saveCredential('kling', 'api_key', { accessKey: 'new' });
    const data = await manager.getCredentialData('kling');
    assert.ok(data);
    assert.equal(data.accessKey, 'new');
  });

  it('removes credentials', async () => {
    const manager = await buildManager();
    await manager.saveCredential('kling', 'api_key', { accessKey: 'ak' });
    const removed = await manager.removeCredential('kling');
    assert.ok(removed);
    const data = await manager.getCredentialData('kling');
    assert.equal(data, null);
  });

  it('returns false when removing non-existent', async () => {
    const manager = await buildManager();
    const removed = await manager.removeCredential('nonexistent');
    assert.ok(!removed);
  });

  it('lists stored credentials without decrypted data', async () => {
    const manager = await buildManager();
    await manager.saveCredential('kling', 'api_key', { accessKey: 'ak1' });
    await manager.saveCredential('jimeng', 'api_key', { accessKey: 'ak2' });
    const list = await manager.listCredentials();
    assert.equal(list.length, 2);
    assert.ok(list.some((c) => c.providerId === 'kling'));
    assert.ok(list.some((c) => c.providerId === 'jimeng'));
    assert.equal(list[0].healthStatus, 'unchecked');
  });

  it('updates health status', async () => {
    const manager = await buildManager();
    await manager.saveCredential('kling', 'api_key', { accessKey: 'ak' });
    await manager.updateHealthStatus('kling', 'healthy');
    const list = await manager.listCredentials();
    const kling = list.find((c) => c.providerId === 'kling');
    assert.ok(kling);
    assert.equal(kling.healthStatus, 'healthy');
    assert.ok(kling.lastHealthAt > 0);
  });

  it('cannot decrypt with wrong key', async () => {
    const { AccountManager } = await import('../dist/mediahub/account-manager.js');
    const redis = createMockRedis();
    const mgr1 = new AccountManager(redis, randomBytes(32));
    await mgr1.saveCredential('kling', 'api_key', { accessKey: 'secret' });
    // Try reading with different key
    const mgr2 = new AccountManager(redis, randomBytes(32));
    const data = await mgr2.getCredentialData('kling');
    assert.equal(data, null); // decryption fails gracefully
  });
});

// ==================== Account Tools Tests ==================

describe('account tools', () => {
  async function setupTools() {
    const { AccountManager } = await import('../dist/mediahub/account-manager.js');
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    const { setAccountRefs, registerProviderFactory } = await import('../dist/mediahub/account-tools.js');

    const redis = createMockRedis();
    const key = randomBytes(32);
    const manager = new AccountManager(redis, key);
    const registry = new ProviderRegistry();
    setAccountRefs(manager, registry);

    // Register mock factory for 'mock' provider
    registerProviderFactory('mock', (data) => {
      if (!data.token) return null;
      return {
        info: { id: 'mock', displayName: 'Mock', capabilities: ['text2video'], models: ['m1'], authMode: 'api_key' },
        supports: () => true,
        submit: async () => ({ providerTaskId: 't1', status: 'running' }),
        queryStatus: async () => ({ status: 'succeeded' }),
      };
    });

    return { manager, registry };
  }

  it('bind_account saves credentials and auto-activates provider', async () => {
    const { registry } = await setupTools();
    const { handleBindAccount } = await import('../dist/mediahub/account-tools.js');

    assert.equal(registry.get('mock'), undefined);
    const result = await handleBindAccount({ provider: 'mock', credentials: { token: 'abc' } });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.activated, true);
    assert.ok(registry.get('mock')); // provider now registered
  });

  it('bind_account rejects missing required fields', async () => {
    await setupTools();
    const { handleBindAccount } = await import('../dist/mediahub/account-tools.js');
    const result = await handleBindAccount({ provider: 'kling', credentials: { accessKey: 'ak' } });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /secretKey/);
  });

  it('unbind_account removes credentials and unregisters provider', async () => {
    const { registry, manager } = await setupTools();
    const { handleBindAccount, handleUnbindAccount } = await import('../dist/mediahub/account-tools.js');

    await handleBindAccount({ provider: 'mock', credentials: { token: 'abc' } });
    assert.ok(registry.get('mock'));

    const result = await handleUnbindAccount({ provider: 'mock' });
    assert.ok(!result.isError);
    assert.equal(registry.get('mock'), undefined);

    const data = await manager.getCredentialData('mock');
    assert.equal(data, null);
  });

  it('unbind_account returns error for non-existent', async () => {
    await setupTools();
    const { handleUnbindAccount } = await import('../dist/mediahub/account-tools.js');
    const result = await handleUnbindAccount({ provider: 'nonexistent' });
    assert.ok(result.isError);
  });

  it('account_status lists bound credentials', async () => {
    await setupTools();
    const { handleBindAccount, handleAccountStatus } = await import('../dist/mediahub/account-tools.js');
    await handleBindAccount({ provider: 'mock', credentials: { token: 'abc' } });

    const result = await handleAccountStatus({ check_health: false });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].provider, 'mock');
    assert.equal(parsed[0].registered, true);
  });

  it('account_status returns message when no accounts', async () => {
    await setupTools();
    const { handleAccountStatus } = await import('../dist/mediahub/account-tools.js');
    const result = await handleAccountStatus({});
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /no bound/i);
  });
});

// ==================== checkHealth regression (gpt52 P2) ==================

describe('KlingProvider.checkHealth', () => {
  const origFetch = globalThis.fetch;

  it('HTTP 500 → unhealthy', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('test-ak', 'test-sk');
    globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('HTTP 200 + business error code → unhealthy', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('test-ak', 'test-sk');
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1001, message: 'invalid request', data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('HTTP 401 → unhealthy', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('test-ak', 'test-sk');
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.match(result.error, /Authentication failed/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('HTTP 200 + code 0 → healthy', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('test-ak', 'test-sk');
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 0, message: 'ok', data: { task_list: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('JimengProvider.checkHealth', () => {
  const origFetch = globalThis.fetch;

  it('HTTP 500 → unhealthy', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('test-ak', 'test-sk');
    globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.ok(result.error);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('HTTP 401 → unhealthy', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('test-ak', 'test-sk');
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.match(result.error, /Authentication failed/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('HTTP 200 + valid JSON → healthy (probe expects business error)', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('test-ak', 'test-sk');
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 20001, message: 'task not found' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('network error → unhealthy', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('test-ak', 'test-sk');
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    try {
      const result = await provider.checkHealth();
      assert.equal(result.healthy, false);
      assert.match(result.error, /ECONNREFUSED/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
