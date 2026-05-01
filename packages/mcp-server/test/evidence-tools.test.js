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

  test('Hook F-1: appends Read reminder when high/mid doc anchors present', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'F177 Harness Update',
            anchor: 'F177',
            snippet: 'hotfix governance',
            confidence: 'high',
            sourceType: 'feature',
          },
          {
            title: 'Session about testing',
            anchor: 'thread:abc123',
            snippet: 'discussed tests',
            confidence: 'high',
            sourceType: 'thread',
          },
          {
            title: 'ADR-019 Hooks',
            anchor: 'doc:decisions/019',
            snippet: 'hook architecture',
            confidence: 'mid',
            sourceType: 'decision',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'F177 hooks' });
    const text = result.content[0].text;

    assert.ok(text.includes('Evidence search results:'), 'should include evidence result marker');
    assert.ok(text.includes('Found 3 result(s) for "F177 hooks":'), 'should include query in result header');
    assert.ok(
      text.includes('📌 高置信度文档命中 2 个'),
      'should count only doc-type hits (feature+decision, not thread)',
    );
    assert.ok(text.includes('F177'), 'should list feature anchor');
    assert.ok(text.includes('doc:decisions/019'), 'should list decision anchor');
    assert.ok(text.includes('摘要是索引，不是答案'), 'should include Read advice');
  });

  test('Hook F-1: no reminder when only thread/low-confidence results', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Thread discussion',
            anchor: 'thread:xyz',
            snippet: 'some chat',
            confidence: 'high',
            sourceType: 'thread',
          },
          {
            title: 'Low feature',
            anchor: 'F999',
            snippet: 'barely relevant',
            confidence: 'low',
            sourceType: 'feature',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'random' });
    const text = result.content[0].text;

    assert.ok(!text.includes('📌 高置信度文档命中'), 'should not show reminder for non-doc or low-confidence results');
  });

  test('Hook F-3: appends invocation search count', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [
          {
            title: 'Test',
            anchor: 'test',
            snippet: 'test',
            confidence: 'low',
            sourceType: 'feature',
          },
        ],
      }),
    });

    const result = await handleSearchEvidence({ query: 'depth test' });
    const text = result.content[0].text;

    assert.ok(text.includes('📊 本轮第'), 'should include invocation search depth counter');
    assert.ok(text.includes('次搜索'), 'should show search count');
  });

  test('Hook F-3: empty results still show depth counter (P2-2 fix)', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        degraded: false,
        results: [],
      }),
    });

    const result = await handleSearchEvidence({ query: 'nonexistent topic' });
    const text = result.content[0].text;

    assert.ok(
      text.includes('Evidence search results: No results found for: nonexistent topic'),
      'empty results should include evidence result marker',
    );
    assert.ok(text.includes('No results found'), 'should report no results');
    assert.ok(text.includes('📊 本轮第'), 'empty results must still include depth counter');
    assert.ok(text.includes('次搜索'), 'empty results must still show search count');
  });

  test('handleSearchEvidence includes query in error output for frontend correlation', async () => {
    const { handleSearchEvidence } = await import('../dist/tools/evidence-tools.js');

    globalThis.fetch = async () => {
      throw new Error('connection refused');
    };

    const result = await handleSearchEvidence({ query: 'quoted "topic"' });
    const text = result.content[0].text;

    assert.equal(result.isError, true);
    assert.ok(
      text.includes('Evidence search request failed for "quoted \\"topic\\"": connection refused'),
      'should include JSON-quoted query in request error output',
    );
  });
});
