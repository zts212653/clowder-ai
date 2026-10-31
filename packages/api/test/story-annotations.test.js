// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

/**
 * F252 Phase D — AnnotationFileStore tests (AC-D1).
 *
 * Tests the file-based annotation store that persists to
 * `data/stories/:storyId/annotations.json`.
 *
 * INV-1: annotation.id unique within set
 * INV-2: version monotonically increases on write
 * INV-3: annotation.at must be within story time range (caller-enforced)
 */

/** @typedef {import('@cat-cafe/shared').StoryAnnotation} StoryAnnotation */
/** @typedef {import('@cat-cafe/shared').AnnotationSet} AnnotationSet */

describe('AnnotationFileStore', () => {
  /** @type {string} */
  let tmpDir;
  /** @type {import('../dist/domains/story/annotation-store.js').AnnotationFileStore} */
  let store;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-store-'));
    const { AnnotationFileStore } = await import('../dist/domains/story/annotation-store.js');
    store = new AnnotationFileStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── GET: empty / non-existent ───────────────────────────────────

  test('get returns empty annotation set for non-existent storyId', async () => {
    const result = await store.get('feat:F999');
    assert.equal(result.storyId, 'feat:F999');
    assert.deepStrictEqual(result.annotations, []);
    assert.equal(result.version, 0);
  });

  // ─── ADD: basic create ───────────────────────────────────────────

  test('add creates annotation and returns it with generated id', async () => {
    const annotation = await store.add('feat:F252', {
      at: 1719360001000,
      kind: 'narration',
      content: 'This is the initial design discussion.',
    });

    assert.ok(annotation.id, 'should have generated id');
    assert.equal(annotation.storyId, 'feat:F252');
    assert.equal(annotation.at, 1719360001000);
    assert.equal(annotation.kind, 'narration');
    assert.equal(annotation.content, 'This is the initial design discussion.');
    assert.ok(annotation.createdAt > 0);
    assert.equal(annotation.createdAt, annotation.updatedAt);
  });

  test('add persists to filesystem and get retrieves it', async () => {
    await store.add('feat:F252', {
      at: 1719360001000,
      kind: 'narration',
      content: 'Test persistence.',
    });

    const set = await store.get('feat:F252');
    assert.equal(set.annotations.length, 1);
    assert.equal(set.version, 1);
    assert.equal(set.annotations[0].content, 'Test persistence.');
  });

  // ─── INV-2: version monotonically increases ─────────────────────

  test('version increments on each write operation', async () => {
    await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'first' });
    const set1 = await store.get('feat:F252');
    assert.equal(set1.version, 1);

    await store.add('feat:F252', { at: 2000, kind: 'highlight', content: 'second' });
    const set2 = await store.get('feat:F252');
    assert.equal(set2.version, 2);
  });

  // ─── UPDATE ──────────────────────────────────────────────────────

  test('update changes annotation content and bumps version', async () => {
    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'original',
    });

    const updated = await store.update('feat:F252', annotation.id, {
      content: 'revised',
    });

    assert.equal(updated.content, 'revised');
    assert.equal(updated.at, 1000); // at unchanged
    assert.ok(updated.updatedAt >= annotation.createdAt);

    const set = await store.get('feat:F252');
    assert.equal(set.version, 2); // 1 from add + 1 from update
  });

  test('update changes annotation at timestamp', async () => {
    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'test',
    });

    const updated = await store.update('feat:F252', annotation.id, { at: 2000 });
    assert.equal(updated.at, 2000);
    assert.equal(updated.content, 'test'); // content unchanged
  });

  test('update with stale version rejects with 409 error', async () => {
    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'test',
    });

    // Simulate stale version by passing expectedVersion=0 (stale)
    await assert.rejects(
      () => store.update('feat:F252', annotation.id, { content: 'new' }, 0),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /version conflict/i);
        return true;
      },
    );
  });

  test('update non-existent annotation throws not-found', async () => {
    await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'test' });

    await assert.rejects(
      () => store.update('feat:F252', 'nonexistent-id', { content: 'new' }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /not found/i);
        return true;
      },
    );
  });

  // ─── REMOVE ──────────────────────────────────────────────────────

  test('remove deletes annotation and bumps version', async () => {
    const a1 = await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'keep' });
    const a2 = await store.add('feat:F252', { at: 2000, kind: 'highlight', content: 'remove me' });

    await store.remove('feat:F252', a2.id);

    const set = await store.get('feat:F252');
    assert.equal(set.annotations.length, 1);
    assert.equal(set.annotations[0].id, a1.id);
    assert.equal(set.version, 3); // 2 adds + 1 remove
  });

  test('remove non-existent annotation throws not-found', async () => {
    await assert.rejects(
      () => store.remove('feat:F252', 'nonexistent'),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /not found/i);
        return true;
      },
    );
  });

  // ─── INV-1: unique id within set ────────────────────────────────

  test('each added annotation gets a unique id', async () => {
    const a1 = await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'first' });
    const a2 = await store.add('feat:F252', { at: 2000, kind: 'narration', content: 'second' });
    const a3 = await store.add('feat:F252', { at: 3000, kind: 'highlight', content: 'third' });

    const ids = new Set([a1.id, a2.id, a3.id]);
    assert.equal(ids.size, 3, 'all annotation IDs should be unique');
  });

  // ─── Isolation between storyIds ──────────────────────────────────

  test('annotations are isolated per storyId', async () => {
    await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'F252 note' });
    await store.add('session:abc123', { at: 2000, kind: 'highlight', content: 'session note' });

    const f252Set = await store.get('feat:F252');
    assert.equal(f252Set.annotations.length, 1);
    assert.equal(f252Set.annotations[0].content, 'F252 note');

    const sessionSet = await store.get('session:abc123');
    assert.equal(sessionSet.annotations.length, 1);
    assert.equal(sessionSet.annotations[0].content, 'session note');
  });

  // ─── File missing mid-session ────────────────────────────────────

  test('get returns empty set after file is externally deleted', async () => {
    await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'test' });

    // Externally delete the file
    const filePath = path.join(tmpDir, 'feat_F252', 'annotations.json');
    await fs.rm(filePath, { force: true });

    const set = await store.get('feat:F252');
    assert.deepStrictEqual(set.annotations, []);
    assert.equal(set.version, 0);
  });

  // ─── P1-4: Concurrent writes must not lose updates ────────────

  test('concurrent adds all persist (no lost updates)', async () => {
    const N = 10;
    // Fire N concurrent adds — without locking, later writes overwrite earlier
    // ones because each reads the same initial state (TOCTOU race).
    const promises = Array.from({ length: N }, (_, i) =>
      store.add('feat:F252', {
        at: 1000 + i * 100,
        kind: 'narration',
        content: `concurrent-${i}`,
      }),
    );

    await Promise.all(promises);

    const set = await store.get('feat:F252');
    assert.equal(
      set.annotations.length,
      N,
      `Expected ${N} annotations but got ${set.annotations.length} — concurrent writes lost updates`,
    );
    assert.equal(set.version, N, `Expected version ${N} but got ${set.version}`);
  });

  test('concurrent updates on same annotation serialize correctly', async () => {
    const a = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'original',
    });

    // Fire 5 concurrent updates — each should see the latest version
    const promises = Array.from({ length: 5 }, (_, i) => store.update('feat:F252', a.id, { content: `update-${i}` }));

    await Promise.all(promises);

    const set = await store.get('feat:F252');
    // 1 add + 5 updates = version 6
    assert.equal(set.version, 6, `Expected version 6 but got ${set.version}`);
    assert.equal(set.annotations.length, 1);
  });

  // ─── P0: Path traversal prevention ──────────────────────────────

  test('storyId with slashes does not escape dataDir (path traversal prevention)', async () => {
    // Fastify decodes %2F → '/' in URL params. Without whitelist sanitization,
    // path.join(dataDir, '../breakout', 'annotations.json') escapes dataDir.
    const dangerousId = '../breakout';

    await store.add(dangerousId, {
      at: 1000,
      kind: 'narration',
      content: 'should stay inside tmpDir',
    });

    // Verify round-trip works (data stored and retrievable)
    const set = await store.get(dangerousId);
    assert.equal(set.annotations.length, 1);
    assert.equal(set.annotations[0].content, 'should stay inside tmpDir');

    // Critical: no file should exist outside tmpDir
    const parentDir = path.dirname(tmpDir);
    const breakoutPath = path.join(parentDir, 'breakout', 'annotations.json');
    let escaped = false;
    try {
      await fs.stat(breakoutPath);
      escaped = true;
      await fs.rm(path.join(parentDir, 'breakout'), { recursive: true, force: true });
    } catch {
      /* expected — file should NOT exist outside tmpDir */
    }
    assert.ok(!escaped, 'Path traversal: storyId with slashes created file outside dataDir');
  });

  test('storyId with encoded path traversal stays contained', async () => {
    // Simulates decoded Fastify param: session:%2F..%2F..%2Ftmp → session:/../../tmp
    const traversalId = 'session:/../../tmp/f252-traversal-test';

    await store.add(traversalId, {
      at: 1000,
      kind: 'narration',
      content: 'traversal attempt',
    });

    const set = await store.get(traversalId);
    assert.equal(set.annotations.length, 1);

    // All data directories should be inside tmpDir
    const entries = await fs.readdir(tmpDir);
    assert.ok(entries.length > 0, 'Data should be stored within tmpDir');
    // None of the entries should contain path separators or dot-dot
    for (const entry of entries) {
      assert.ok(!entry.includes('/'), `Entry "${entry}" contains path separator`);
      assert.ok(!entry.includes('..'), `Entry "${entry}" contains dot-dot traversal`);
    }
  });

  // ─── PUT validation — cloud R4 P2-4 ──────────────────────────────

  test('update rejects non-number at field (store level accepts, route must guard)', async () => {
    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'test',
    });

    // Store level has no type guard on `at` — the route handler is the gate.
    // This test documents that store accepts any `at` value,
    // proving the route validation is the critical defense layer.
    const updated = await store.update('feat:F252', annotation.id, { at: /** @type {any} */ ('bad') });
    assert.equal(updated.at, 'bad', 'Store accepts non-number at (route must validate)');
  });

  // ─── File missing mid-session ────────────────────────────────────

  test('add recreates file after external deletion', async () => {
    await store.add('feat:F252', { at: 1000, kind: 'narration', content: 'before delete' });

    // Externally delete the file
    const filePath = path.join(tmpDir, 'feat_F252', 'annotations.json');
    await fs.rm(filePath, { force: true });

    // Adding should create fresh
    const annotation = await store.add('feat:F252', { at: 2000, kind: 'narration', content: 'after delete' });

    const set = await store.get('feat:F252');
    assert.equal(set.annotations.length, 1);
    assert.equal(set.annotations[0].id, annotation.id);
    assert.equal(set.version, 1); // fresh start
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route-level tests (Fastify inject) — cloud R4 P2-4 regression guard
// ═══════════════════════════════════════════════════════════════════════════

describe('Story Annotation Routes (HTTP)', () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-route-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createApp() {
    const { default: Fastify } = await import('fastify');
    const { AnnotationFileStore } = await import('../dist/domains/story/annotation-store.js');
    const { storyAnnotationRoutes } = await import('../dist/routes/story-annotations.js');

    const store = new AnnotationFileStore(tmpDir);
    const app = Fastify();

    // Fake auth — set sessionUserId on all requests to bypass isAuthenticated
    app.addHook('onRequest', async (request) => {
      /** @type {any} */ (request).sessionUserId = 'test-user';
    });

    await app.register(storyAnnotationRoutes, { annotationStore: store });
    return { app, store };
  }

  test('PUT rejects non-number at field with 400 (cloud R4 P2-4)', async () => {
    const { app, store } = await createApp();

    // Create an annotation first (via store directly — route POST tested elsewhere)
    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'test annotation',
    });

    // PUT with bad `at` should return 400
    const response = await app.inject({
      method: 'PUT',
      url: `/api/story/feat:F252/annotations/${annotation.id}`,
      payload: { at: 'not-a-number' },
    });

    assert.equal(response.statusCode, 400, `Expected 400 but got ${response.statusCode}: ${response.body}`);
    const body = JSON.parse(response.body);
    assert.equal(body.error, 'invalid_input');
    assert.ok(body.message.includes('number'), `Error message should mention number: ${body.message}`);
  });

  test('PUT accepts valid number at field', async () => {
    const { app, store } = await createApp();

    const annotation = await store.add('feat:F252', {
      at: 1000,
      kind: 'narration',
      content: 'test annotation',
    });

    const response = await app.inject({
      method: 'PUT',
      url: `/api/story/feat:F252/annotations/${annotation.id}`,
      payload: { at: 2000 },
    });

    assert.equal(response.statusCode, 200, `Expected 200 but got ${response.statusCode}: ${response.body}`);
    const body = JSON.parse(response.body);
    assert.equal(body.at, 2000);
  });
});
