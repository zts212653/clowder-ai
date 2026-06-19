import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

import { FeishuTokenManager } from '../dist/infrastructure/connectors/im-connectors/feishu/FeishuTokenManager.js';

describe('FeishuTokenManager', () => {
  test('fetches tenant_access_token from Feishu API', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tenant_access_token: 'tok-123',
            expire: 7200,
          }),
      }),
    );

    const mgr = new FeishuTokenManager({
      appId: 'app1',
      appSecret: 'sec1',
      fetchFn: /** @type {any} */ (mockFetch),
    });

    const token = await mgr.getTenantAccessToken();
    assert.equal(token, 'tok-123');
    assert.equal(mockFetch.mock.calls.length, 1);

    const [url, opts] = mockFetch.mock.calls[0].arguments;
    assert.ok(url.includes('/auth/v3/tenant_access_token/internal'));
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.app_id, 'app1');
    assert.equal(body.app_secret, 'sec1');
  });

  test('caches token and reuses on second call', async () => {
    const mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tenant_access_token: 'tok-456',
            expire: 7200,
          }),
      }),
    );

    const mgr = new FeishuTokenManager({
      appId: 'a',
      appSecret: 's',
      fetchFn: /** @type {any} */ (mockFetch),
    });

    const t1 = await mgr.getTenantAccessToken();
    const t2 = await mgr.getTenantAccessToken();
    assert.equal(t1, 'tok-456');
    assert.equal(t2, 'tok-456');
    assert.equal(mockFetch.mock.calls.length, 1);
  });

  test('re-fetches token after expiry', async () => {
    let callCount = 0;
    const mockFetch = mock.fn(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            tenant_access_token: `tok-${callCount}`,
            expire: 1, // 1 second — will expire after 300s buffer makes it negative
          }),
      });
    });

    const mgr = new FeishuTokenManager({
      appId: 'a',
      appSecret: 's',
      fetchFn: /** @type {any} */ (mockFetch),
    });

    await mgr.getTenantAccessToken();
    // Token with expire=1 means expiresAt = now + (1 - 300) * 1000 = already expired
    const t2 = await mgr.getTenantAccessToken();
    assert.equal(t2, 'tok-2');
    assert.equal(mockFetch.mock.calls.length, 2);
  });

  test('throws on non-ok response', async () => {
    const mockFetch = mock.fn(() => Promise.resolve({ ok: false, status: 500 }));

    const mgr = new FeishuTokenManager({
      appId: 'a',
      appSecret: 's',
      fetchFn: /** @type {any} */ (mockFetch),
    });

    await assert.rejects(() => mgr.getTenantAccessToken(), /500/);
  });
});
