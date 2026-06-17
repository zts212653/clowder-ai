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
    delete process.env.CAT_CAFE_THREAD_ID;
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

  test('handleListRecent forwards current thread and renders suggested cross-post action', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');
    process.env.CAT_CAFE_THREAD_ID = 'thread-current';

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              anchor: 'thread-other',
              title: 'Other thread',
              kind: 'thread',
              updatedAt: '2026-05-10T11:00:00Z',
              source: 'project:cafe',
              suggestedAction: {
                type: 'cross_post',
                threadId: 'thread-other',
                reason: 'Recent item is another thread; dispatch relevant findings back to that thread.',
                source: 'list_recent',
              },
            },
          ],
        }),
      };
    };

    const result = await handleListRecent({ scope: 'threads', since: '7d' });

    assert.equal(result.isError, undefined);
    const parsed = new URL(String(capturedUrl));
    assert.equal(parsed.searchParams.get('currentThreadId'), 'thread-current');
    const text = result.content[0].text;
    // Compact format: no per-item routing/reason boilerplate, just a footer tip
    assert.ok(text.includes('thread-other'), 'thread item present in output');
    assert.ok(!text.includes('routing: replace @target-cat'), 'no per-item routing boilerplate');
    assert.ok(!text.includes('reason: Recent item is another thread'), 'no per-item reason boilerplate');
    assert.ok(text.includes('cat_cafe_cross_post_message'), 'footer uses registered MCP tool name');
    assert.ok(text.includes('targetCats or'), 'footer explains routing requirement (targetCats or @mention)');
    // Normalized threadId visible per-item (cloud P1 fix)
    assert.ok(text.includes('→ cross-post: thread-other'), 'normalized threadId visible');
  });

  test('multiple thread items do NOT repeat per-item routing/reason boilerplate (context tax fix)', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');
    process.env.CAT_CAFE_THREAD_ID = 'thread-current';

    const makeThreadItem = (id) => ({
      anchor: `thread-${id}`,
      title: `Thread ${id}`,
      kind: 'thread',
      updatedAt: '2026-06-10T12:00:00Z',
      source: 'project:cafe',
      suggestedAction: {
        type: 'cross_post',
        threadId: id,
        reason: 'Recent item is another thread; dispatch relevant findings back to that thread.',
        source: 'list_recent',
      },
    });

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          makeThreadItem('thread_aaa'),
          makeThreadItem('thread_bbb'),
          makeThreadItem('thread_ccc'),
          {
            anchor: 'F200',
            title: 'Memory Eval',
            kind: 'feature',
            updatedAt: '2026-06-10T11:00:00Z',
            source: 'project:cafe',
          },
        ],
      }),
    });

    const result = await handleListRecent({ scope: 'all', since: '7d' });
    const text = result.content[0].text;

    // Thread items should still be in the output
    assert.ok(text.includes('thread_aaa'), 'thread_aaa item present');
    assert.ok(text.includes('thread_bbb'), 'thread_bbb item present');
    assert.ok(text.includes('thread_ccc'), 'thread_ccc item present');

    // Per-item verbose boilerplate must NOT appear
    assert.ok(!text.includes('routing: replace @target-cat'), 'no per-item routing boilerplate');
    assert.ok(!text.includes('reason: Recent item is another thread'), 'no per-item reason boilerplate');

    // Normalized threadId must be visible per-item for cross_post_message (cloud P1 fix)
    assert.ok(text.includes('→ cross-post: thread_aaa'), 'normalized threadId for thread_aaa');
    assert.ok(text.includes('→ cross-post: thread_bbb'), 'normalized threadId for thread_bbb');
    assert.ok(text.includes('→ cross-post: thread_ccc'), 'normalized threadId for thread_ccc');

    // A single footer cross-post tip should exist with routing requirement
    assert.ok(text.includes('cat_cafe_cross_post_message'), 'footer uses registered MCP tool name');
    assert.ok(text.includes('targetCats or'), 'footer explains routing requirement (targetCats or @mention)');

    // Non-thread items unaffected
    assert.ok(text.includes('F200 — Memory Eval'));
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

  test('renders collection distribution footer when groups present (AC-H4)', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          { anchor: 'F001', title: 'Doc1', kind: 'feature', updatedAt: '2026-05-19T12:00:00Z', source: 'project:cafe' },
          {
            anchor: 'F002',
            title: 'Doc2',
            kind: 'research',
            updatedAt: '2026-05-18T12:00:00Z',
            source: 'domain:finance',
          },
        ],
        groups: [
          { key: 'project:cafe', type: 'collection', label: 'Clowder AI Project', count: 6, available: 10 },
          { key: 'domain:finance', type: 'collection', label: 'Finance', count: 2, available: 5 },
        ],
      }),
    });

    const result = await handleListRecent({ since: '7d' });
    const text = result.content[0].text;
    assert.ok(text.includes('Collections:'), 'footer must contain Collections: header');
    assert.ok(text.includes('Clowder AI Project(6/10)'), 'footer must show collection with count/available');
    assert.ok(text.includes('Finance(2/5)'), 'footer must show second collection');
  });

  test('omits collection footer for single collection', async () => {
    const { handleListRecent } = await import('../dist/tools/recent-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        items: [
          { anchor: 'F001', title: 'Doc1', kind: 'feature', updatedAt: '2026-05-19T12:00:00Z', source: 'project:cafe' },
        ],
      }),
    });

    const result = await handleListRecent({ since: '7d' });
    const text = result.content[0].text;
    assert.ok(!text.includes('Collections:'), 'no footer for single collection');
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
