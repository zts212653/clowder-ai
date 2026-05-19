/**
 * MCP Library Lifecycle Tools Tests — F188 Phase I (AC-I4)
 *
 * Verifies URL encoding, rendering, KD-8 schema, error handling
 * for: library_list, library_dry_run, library_create, library_rebuild, library_archive
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

  test('handleLibraryDryRun calls /api/library/bind-dry-run', async () => {
    const { handleLibraryDryRun } = await import('../dist/tools/library-lifecycle-tools.js');

    let capturedUrl, capturedBody;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts?.body);
      return {
        ok: true,
        json: async () => ({
          fileCount: 42,
          totalSizeBytes: 100000,
          suggestedScannerLevel: 1,
          secretsDetected: false,
        }),
      };
    };

    const result = await handleLibraryDryRun({ root: '/home/user/docs' });
    assert.ok(String(capturedUrl).includes('/api/library/bind-dry-run'));
    assert.equal(capturedBody.root, '/home/user/docs');
    const text = result.content[0].text;
    assert.ok(text.includes('42'));
  });

  test('handleLibraryCreate calls register then auto-triggers rebuild', async () => {
    const { handleLibraryCreate } = await import('../dist/tools/library-lifecycle-tools.js');

    const fetchedUrls = [];
    let capturedBody;
    globalThis.fetch = async (url, opts) => {
      fetchedUrls.push(String(url));
      if (String(url).includes('/register')) {
        capturedBody = JSON.parse(opts?.body);
        return {
          ok: true,
          json: async () => ({
            manifest: {
              id: 'domain:finance',
              kind: 'domain',
              name: 'finance',
              displayName: 'Finance',
              root: '/home/user/docs',
              sensitivity: 'private',
              status: 'registered',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ indexed: 5, skipped: 0, blocked: false, secretFindings: [] }) };
    };

    const result = await handleLibraryCreate({
      kind: 'domain',
      name: 'finance',
      displayName: 'Finance',
      root: '/home/user/docs',
      sensitivity: 'private',
    });
    assert.equal(capturedBody.id, 'domain:finance');
    assert.equal(capturedBody.kind, 'domain');
    assert.ok(
      fetchedUrls.some((u) => u.includes('/register')),
      'should call register',
    );
    assert.ok(
      fetchedUrls.some((u) => u.includes('/rebuild')),
      'should auto-trigger rebuild after register',
    );
    const text = result.content[0].text;
    assert.ok(text.includes('domain:finance'));
  });

  test('handleLibraryCreate surfaces rebuild failure in result', async () => {
    const { handleLibraryCreate } = await import('../dist/tools/library-lifecycle-tools.js');

    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('/register')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              id: 'domain:docs',
              kind: 'domain',
              name: 'docs',
              displayName: 'Documents',
              root: '/tmp/docs',
              sensitivity: 'private',
              status: 'registered',
            },
          }),
        };
      }
      return { ok: false, status: 500, text: async () => 'rebuild exploded' };
    };

    const result = await handleLibraryCreate({
      kind: 'domain',
      name: 'docs',
      displayName: 'Documents',
      root: '/tmp/docs',
      sensitivity: 'private',
    });
    assert.equal(result.isError, undefined, 'creation itself should succeed');
    const text = result.content[0].text;
    assert.ok(text.includes('domain:docs'));
    assert.ok(
      /warning|rebuild failed|rebuild error/i.test(text),
      `result must surface rebuild failure/warning, got: ${text.slice(0, 200)}`,
    );
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

  test('handleLibraryArchive calls /api/library/:id/archive', async () => {
    const { handleLibraryArchive } = await import('../dist/tools/library-lifecycle-tools.js');

    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          manifest: { id: 'domain:finance', status: 'archived', displayName: 'Finance' },
        }),
      };
    };

    const result = await handleLibraryArchive({ collectionId: 'domain:finance' });
    assert.ok(String(capturedUrl).includes('/api/library/domain:finance/archive'));
    const text = result.content[0].text;
    assert.ok(text.includes('archived'));
  });

  test('tool exports have correct names and count', async () => {
    const { libraryLifecycleTools } = await import('../dist/tools/library-lifecycle-tools.js');
    assert.equal(libraryLifecycleTools.length, 5);
    const names = libraryLifecycleTools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'cat_cafe_library_archive',
      'cat_cafe_library_create',
      'cat_cafe_library_dry_run',
      'cat_cafe_library_list',
      'cat_cafe_library_rebuild',
    ]);
  });

  test('KD-8 — no schema contains callerCollections or collections', async () => {
    const { libraryLifecycleTools } = await import('../dist/tools/library-lifecycle-tools.js');
    for (const tool of libraryLifecycleTools) {
      const keys = Object.keys(tool.inputSchema);
      assert.ok(!keys.includes('callerCollections'), `${tool.name}: callerCollections must not appear (KD-8)`);
      assert.ok(!keys.includes('collections'), `${tool.name}: collections must not appear (KD-8)`);
    }
  });

  test('handleLibraryCreate warns when rebuild reports blocked (secrets found)', async () => {
    const { handleLibraryCreate } = await import('../dist/tools/library-lifecycle-tools.js');

    globalThis.fetch = async (url) => {
      if (String(url).includes('/register')) {
        return {
          ok: true,
          json: async () => ({
            manifest: {
              id: 'domain:risky',
              kind: 'domain',
              name: 'risky',
              displayName: 'Risky Docs',
              root: '/tmp/risky',
              sensitivity: 'private',
              status: 'registered',
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ indexed: 3, skipped: 0, blocked: true, secretFindings: 2 }),
      };
    };

    const result = await handleLibraryCreate({
      kind: 'domain',
      name: 'risky',
      displayName: 'Risky Docs',
      root: '/tmp/risky',
    });
    assert.equal(result.isError, undefined, 'creation itself should succeed');
    const text = result.content[0].text;
    assert.ok(text.includes('domain:risky'), 'should show collection id');
    assert.ok(/blocked|secret/i.test(text), `result must warn about blocked/secrets state, got: ${text.slice(0, 300)}`);
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
