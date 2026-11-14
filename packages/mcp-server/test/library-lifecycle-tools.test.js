/**
 * MCP Library Lifecycle Tools Tests — F188 Phase I (AC-I4)
 *
 * Verifies URL encoding, rendering, KD-8 schema, error handling
 * for: library_list, library_rebuild (archive moved to the owner page 2026-11-09; create/dry-run 2026-11-10)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('MCP Library Lifecycle Tools (AC-I4)', () => {
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

  test('handleLibraryList calls /api/library/catalog and formats result', async () => {
    const { handleLibraryList } = await import('../dist/tools/library-lifecycle-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          collections: [
            {
              manifest: {
                id: 'domain:finance',
                displayName: 'Finance',
                sensitivity: 'private',
                status: 'active',
                kind: 'domain',
              },
              overview: { docCount: 10, wordCount: 5000 },
            },
          ],
        }),
      };
    };

    const result = await handleLibraryList({});
    assert.ok(String(capturedUrl).includes('/api/library/catalog'));
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(text.includes('domain:finance'));
    assert.ok(text.includes('Finance'));
    assert.ok(text.includes('10 docs'), 'should display docCount from API');
  });

  test('handleLibraryList filters by status', async () => {
    const { handleLibraryList } = await import('../dist/tools/library-lifecycle-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        collections: [
          {
            manifest: { id: 'domain:a', displayName: 'A', status: 'active', sensitivity: 'internal', kind: 'domain' },
            overview: null,
          },
          {
            manifest: { id: 'domain:b', displayName: 'B', status: 'archived', sensitivity: 'internal', kind: 'domain' },
            overview: null,
          },
        ],
      }),
    });

    const result = await handleLibraryList({ status: 'active' });
    const text = result.content[0].text;
    assert.ok(text.includes('domain:a'));
    assert.ok(!text.includes('domain:b'));
  });

  test('handleLibraryList status filter treats missing status as active', async () => {
    const { handleLibraryList } = await import('../dist/tools/library-lifecycle-tools.js');

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        collections: [
          {
            manifest: { id: 'project:cat-cafe', displayName: 'Clowder AI', sensitivity: 'private', kind: 'project' },
            overview: { docCount: 50 },
          },
          {
            manifest: {
              id: 'domain:archived',
              displayName: 'Old',
              status: 'archived',
              sensitivity: 'internal',
              kind: 'domain',
            },
            overview: null,
          },
        ],
      }),
    });

    const result = await handleLibraryList({ status: 'active' });
    const text = result.content[0].text;
    assert.ok(text.includes('project:cat-cafe'), 'collection without status field should match active filter');
    assert.ok(!text.includes('domain:archived'), 'archived should not match active filter');
  });

  test('handleLibraryRebuild calls /api/library/:id/rebuild', async () => {
    const { handleLibraryRebuild } = await import('../dist/tools/library-lifecycle-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({ added: 10, removed: 2, unchanged: 30, elapsed: 1200 }),
      };
    };

    const result = await handleLibraryRebuild({ collectionId: 'domain:finance' });
    assert.ok(String(capturedUrl).includes('/api/library/domain:finance/rebuild'));
    const text = result.content[0].text;
    assert.ok(text.includes('10'));
  });

  test('tool exports have correct names and count', async () => {
    const { libraryLifecycleTools } = await import('../dist/tools/library-lifecycle-tools.js');
    assert.equal(libraryLifecycleTools.length, 3);
    const names = libraryLifecycleTools.map((t) => t.name).sort();
    assert.deepEqual(names, ['cat_cafe_library_list', 'cat_cafe_library_rebuild', 'cat_cafe_library_verify']);
  });

  test('KD-8 — no schema contains callerCollections or collections', async () => {
    const { libraryLifecycleTools } = await import('../dist/tools/library-lifecycle-tools.js');
    for (const tool of libraryLifecycleTools) {
      const keys = Object.keys(tool.inputSchema);
      assert.ok(!keys.includes('callerCollections'), `${tool.name}: callerCollections must not appear (KD-8)`);
      assert.ok(!keys.includes('collections'), `${tool.name}: collections must not appear (KD-8)`);
    }
  });

  test('handles fetch error gracefully', async () => {
    const { handleLibraryList } = await import('../dist/tools/library-lifecycle-tools.js');
    globalThis.fetch = async () => {
      throw new Error('econnrefused');
    };
    const result = await handleLibraryList({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('econnrefused'));
  });
});
