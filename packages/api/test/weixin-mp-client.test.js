import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { PluginRestExecutor } from '../dist/domains/limb/PluginRestExecutor.js';

const originalFetch = globalThis.fetch;

describe('PluginRestExecutor', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves body template with params', () => {
    const tokenManager = { getAccessToken: async () => 'token', isTokenExpiredError: () => false };
    const executor = new PluginRestExecutor('https://api.example.com', tokenManager, null, 'query', 'access_token');

    const result = executor.resolveBodyTemplate(
      { offset: '${params.offset}', count: '${params.count}', fixed: 1 },
      { offset: 0, count: 10 },
    );

    assert.deepEqual(result, { offset: 0, count: 10, fixed: 1 });
  });

  it('resolves nested array body template', () => {
    const tokenManager = { getAccessToken: async () => 'token', isTokenExpiredError: () => false };
    const executor = new PluginRestExecutor('https://api.example.com', tokenManager, null, 'query', 'access_token');

    const result = executor.resolveBodyTemplate(
      { articles: [{ title: '${params.title}', show_cover_pic: 1 }] },
      { title: 'Hello World' },
    );

    assert.deepEqual(result, { articles: [{ title: 'Hello World', show_cover_pic: 1 }] });
  });

  it('omits keys with undefined param values', () => {
    const tokenManager = { getAccessToken: async () => 'token', isTokenExpiredError: () => false };
    const executor = new PluginRestExecutor('https://api.example.com', tokenManager, null, 'query', 'access_token');

    const result = executor.resolveBodyTemplate(
      { title: '${params.title}', author: '${params.author}' },
      { title: 'Test' },
    );

    assert.deepEqual(result, { title: 'Test' });
  });

  it('invalidates and retries on token expired error', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return { ok: true, json: async () => ({ errcode: 40001, errmsg: 'invalid access_token' }) };
      }
      return { ok: true, json: async () => ({ errcode: 0, media_id: 'draft-media-id' }) };
    };

    let tokenCalls = 0;
    let invalidateCalls = 0;
    const tokenManager = {
      getAccessToken: async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? 'cached-token' : 'fresh-token';
      },
      invalidateAccessToken: async () => {
        invalidateCalls += 1;
      },
      isTokenExpiredError: (code) => code === 40001,
    };

    const executor = new PluginRestExecutor(
      'https://api.example.com',
      tokenManager,
      { codePath: 'errcode', messagePath: 'errmsg' },
      'query',
      'access_token',
    );

    const result = await executor.execute(
      {
        type: 'rest',
        description: 'test',
        params: {},
        endpoint: '/draft/add',
        method: 'POST',
        body: { articles: [] },
      },
      {},
    );

    assert.equal(result.success, true);
    assert.equal(invalidateCalls, 1);
    assert.equal(tokenCalls, 2);
    assert.match(urls[0], /access_token=cached-token/);
    assert.match(urls[1], /access_token=fresh-token/);
  });

  it('sends access tokens in the configured header for header auth mode', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), headers: init?.headers ?? {} });
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const tokenManager = {
      getAccessToken: async () => 'header-token',
      isTokenExpiredError: () => false,
    };
    const executor = new PluginRestExecutor('https://api.example.com', tokenManager, null, 'header', 'X-Plugin-Token');

    const result = await executor.execute(
      {
        type: 'rest',
        description: 'test',
        params: {},
        endpoint: '/status',
        method: 'GET',
      },
      {},
    );

    assert.equal(result.success, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.example.com/status');
    assert.equal(requests[0].headers['X-Plugin-Token'], 'header-token');
    assert.equal(requests[0].headers['Content-Type'], 'application/json');
  });
});
