/**
 * MCP Recent Tools Tests — F188 Phase F (AC-F2)
 *
 * Verifies URL encoding, rendering, KD-8 schema, error handling.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP List Recent Tool (AC-F2)', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3004';
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('handleListRecent encodes since/limit/kinds, calls /api/library/recent', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ items: [] }) };
    };

    await handleListRecent({ since: '24h', limit: 10, kinds: ['feature', 'decision'] });
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.pathname, '/api/library/recent');
    assert.equal(parsed.searchParams.get('since'), '24h');
    assert.equal(parsed.searchParams.get('limit'), '10');
    assert.equal(parsed.searchParams.get('kinds'), 'feature,decision');
  });

  test('renders items with date/anchor/title/kind/source + cross-reference footer', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            anchor: 'F186',
            title: 'Library Memory',
            kind: 'feature',
            updatedAt: '2026-05-10T11:00:00Z',
            source: 'project:cafe',
          },
          {
            anchor: 'F188',
            title: 'Stewardship',
            kind: 'feature',
            updatedAt: '2026-05-09T10:00:00Z',
            source: 'project:cafe',
          },
        ],
      }),
    });

    const result = await handleListRecent({ since: '7d' });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('Recent items (last 7d): 2 found'));
    assert.ok(text.includes('2026-05-10 | F186 — Library Memory'));
    assert.ok(text.includes('source: project:cafe'));
    assert.ok(text.includes('7-tool memory family'), 'cross-reference footer present');
  });

  test('renders empty result gracefully', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ items: [] }),
    });

    const result = await handleListRecent({});
    assert.ok(result.content[0].text.includes('(no items in this window)'));
  });

  test('KD-8 — schema does NOT contain callerCollections/collections/dimension', async () => {
    const { listRecentInputSchema, recentTools } = await import('../dist/tools/recent-tools.js');
    const keys = Object.keys(listRecentInputSchema);
    assert.ok(!keys.includes('callerCollections'), 'callerCollections must not be in MCP schema (KD-8)');
    assert.ok(!keys.includes('collections'), 'collections deferred to v2 with server-side identity derivation');
    assert.ok(!keys.includes('dimension'), 'dimension deferred to v2');
    assert.deepEqual(keys.sort(), ['kinds', 'limit', 'scope', 'since'].sort());
    assert.equal(recentTools.length, 1);
    assert.equal(recentTools[0].name, 'cat_cafe_list_recent');
    assert.ok(recentTools[0].description.includes('KD-8'), 'description must mention KD-8 v1 limitation');
  });

  test('description states updatedAt is source-file mtime for docs/memory entries', async () => {
    const { recentTools } = await import('../dist/tools/recent-tools.js');
    const description = recentTools[0].description;

    assert.ok(description.includes('updatedAt'), 'description should explain timestamp semantics');
    assert.ok(description.includes('mtime'), 'description should say docs/memory timestamps use file mtime');
    assert.ok(description.includes('scope/kinds'), 'description should warn about scope/kinds intersection');
  });

  test('handles fetch error gracefully', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');
    globalThis.fetch = async () => {
      throw new Error('econnrefused');
    };
    const result = await handleListRecent({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('econnrefused'));
  });

  test('omits since param when not provided (server defaults to 7d)', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ items: [] }) };
    };

    await handleListRecent({});
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.searchParams.get('since'), null);
    assert.equal(parsed.searchParams.get('limit'), null);
  });
});
