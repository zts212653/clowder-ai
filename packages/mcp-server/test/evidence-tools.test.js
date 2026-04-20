/**
 * MCP Evidence Tools Tests
 * 测试 cat_cafe_search_evidence 的参数编码与降级提示行为。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Evidence Tools', () => {
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

  // Note: `await import()` is cached by ESM — API_URL is evaluated once at module load.
  // Tests share the same CAT_CAFE_API_URL from beforeEach, so this works.
  // If future tests need different URLs, refactor to a factory or re-export a setter.
  test('handleSearchEvidence encodes query and optional params into URL', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    /** @type {string | URL | undefined} */
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ results: [], degraded: false }),
      };
    };

    const result = await handleSearchEvidence({
      query: 'hindsight',
      scope: 'docs',
      mode: 'hybrid',
    });

    assert.equal(result.isError, undefined);
    assert.ok(capturedUrl, 'expected fetch to be called');

    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/evidence/search');
    assert.equal(parsed.searchParams.get('q'), 'hindsight');
    assert.equal(parsed.searchParams.get('scope'), 'docs');
    assert.equal(parsed.searchParams.get('mode'), 'hybrid');
  });

  test('handleSearchEvidence renders raw_lexical_only as graceful degradation, not store error', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: true,
        degradeReason: 'raw_lexical_only',
        effectiveMode: 'lexical',
        results: [
          {
            title: 'Decision A',
            anchor: 'docs/decisions/a.md',
            snippet: 'fallback result',
            confidence: 'low',
            sourceType: 'decision',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'decision' });

    assert.equal(result.isError, undefined);
    assert.ok(
      result.content[0].text.includes('depth=raw currently uses lexical retrieval only'),
      'expected graceful raw degrade message in response text',
    );
    assert.ok(!result.content[0].text.includes('Evidence store error'), 'must not misreport graceful degradation');
  });
});
