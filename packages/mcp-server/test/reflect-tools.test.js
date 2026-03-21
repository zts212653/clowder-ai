/**
 * MCP Reflect Tools Tests
 * 测试 cat_cafe_reflect 的 POST 调用与降级行为。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Reflect Tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleReflect posts query and returns reflection text', async () => {
    const { handleReflect } = await import('../dist/tools/reflect-tools.js');

    /** @type {{ method?: string; body?: string }} */
    let capturedOpts;
    globalThis.fetch = async (_url, opts) => {
      capturedOpts = opts;
      return {
        ok: true,
        json: async () => ({
          reflection: 'Per-cat budgets replaced the global 32k limit.',
          degraded: false,
        }),
      };
    };

    const result = await handleReflect({ query: 'Why per-cat budgets?' });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('Per-cat budgets'));
    assert.equal(capturedOpts.method, 'POST');
    const body = JSON.parse(capturedOpts.body);
    assert.equal(body.query, 'Why per-cat budgets?');
  });

  test('handleReflect returns degraded message when Hindsight is unavailable', async () => {
    const { handleReflect } = await import('../dist/tools/reflect-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        reflection: '',
        degraded: true,
        degradeReason: 'hindsight_unavailable',
      }),
    });

    const result = await handleReflect({ query: 'test' });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes('[DEGRADED]'), 'expected degraded prefix');
    assert.ok(result.content[0].text.includes('hindsight_unavailable'), 'expected reason in text');
  });

  test('handleReflect returns error on fetch failure', async () => {
    const { handleReflect } = await import('../dist/tools/reflect-tools.js');

    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await handleReflect({ query: 'test' });

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('ECONNREFUSED'));
  });
});
