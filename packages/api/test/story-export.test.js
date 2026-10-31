// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

/**
 * F252 Phase D — StoryExportStore tests (AC-D2).
 *
 * Tests the file-based export store that creates sanitized export
 * packs at `data/stories/:storyId/exports/:exportId/`.
 *
 * INV-4: Export pack immutable after creation
 * INV-5: Public URL only serves if export exists (404 otherwise)
 * INV-6: No sensitive content in export (delegated to content-sanitizer)
 */

describe('StoryExportStore', () => {
  /** @type {string} */
  let tmpDir;
  /** @type {import('../dist/domains/story/export-store.js').StoryExportStore} */
  let exportStore;
  /** @type {import('../dist/domains/story/annotation-store.js').AnnotationFileStore} */
  let annotationStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'export-store-'));
    const { StoryExportStore } = await import('../dist/domains/story/export-store.js');
    const { AnnotationFileStore } = await import('../dist/domains/story/annotation-store.js');
    exportStore = new StoryExportStore(tmpDir);
    annotationStore = new AnnotationFileStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── CREATE ────────────────────────────────────────────────────

  test('create produces export pack with manifest + sanitized events', async () => {
    const events = [
      { id: 'e1', at: 1000, kind: 'text', content: 'Safe discussion about design' },
      {
        id: 'e2',
        at: 2000,
        kind: 'tool_use',
        content: 'Read /home/user/cat-cafe/src/index.ts',
      },
    ];

    const result = await exportStore.create('feat:F252', 'F252 Story', events, []);

    assert.ok(result.manifest.exportId);
    assert.equal(result.manifest.storyId, 'feat:F252');
    assert.equal(result.manifest.title, 'F252 Story');
    assert.equal(result.manifest.eventCount, 2);
    assert.equal(result.events.length, 2);

    // INV-6: path should be redacted
    assert.ok(!result.events[1].content.includes('/home/user'));
    assert.ok(result.events[1].content.includes('[PATH]'));
  });

  test('create persists export to filesystem', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    const pack = await exportStore.create('feat:F252', 'Title', events, []);

    // Verify file exists on disk
    const exportDir = path.join(tmpDir, 'feat_F252', 'exports', pack.manifest.exportId);
    const stat = await fs.stat(exportDir);
    assert.ok(stat.isDirectory());

    const manifestFile = path.join(exportDir, 'manifest.json');
    const eventsFile = path.join(exportDir, 'events.json');
    const manifestData = JSON.parse(await fs.readFile(manifestFile, 'utf-8'));
    const eventsData = JSON.parse(await fs.readFile(eventsFile, 'utf-8'));

    assert.equal(manifestData.exportId, pack.manifest.exportId);
    assert.equal(eventsData.length, 1);
  });

  test('create includes annotations in manifest', async () => {
    // Pre-add an annotation
    const annotation = await annotationStore.add('feat:F252', {
      at: 1500,
      kind: 'narration',
      content: 'Key insight here',
    });

    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'event' }];
    const pack = await exportStore.create('feat:F252', 'Title', events, [annotation]);

    assert.equal(pack.manifest.annotations.length, 1);
    assert.equal(pack.manifest.annotations[0].content, 'Key insight here');
  });

  // ─── GET (public access) ───────────────────────────────────────

  test('get returns export pack by storyId + exportId', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    const created = await exportStore.create('feat:F252', 'Title', events, []);

    const retrieved = await exportStore.get('feat:F252', created.manifest.exportId);
    assert.ok(retrieved);
    assert.equal(retrieved.manifest.exportId, created.manifest.exportId);
    assert.equal(retrieved.events.length, 1);
  });

  // INV-5: 404 for non-existent
  test('get returns null for non-existent exportId', async () => {
    const result = await exportStore.get('feat:F252', 'nonexistent-id');
    assert.equal(result, null);
  });

  test('get returns null for non-existent storyId', async () => {
    const result = await exportStore.get('feat:F999', 'any-id');
    assert.equal(result, null);
  });

  // ─── GET LATEST ────────────────────────────────────────────────

  test('getLatest returns the most recent export for a storyId', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    await exportStore.create('feat:F252', 'First', events, []);
    // Ensure different exportedAt timestamps (Date.now() resolution is 1ms)
    await new Promise((r) => setTimeout(r, 10));
    const second = await exportStore.create('feat:F252', 'Second', events, []);

    const latest = await exportStore.getLatest('feat:F252');
    assert.ok(latest);
    assert.equal(latest.manifest.exportId, second.manifest.exportId);
    assert.equal(latest.manifest.title, 'Second');
  });

  test('getLatest returns null when no exports exist', async () => {
    const result = await exportStore.getLatest('feat:F999');
    assert.equal(result, null);
  });

  // ─── DELETE ────────────────────────────────────────────────────

  test('delete removes export from filesystem', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    const pack = await exportStore.create('feat:F252', 'Title', events, []);

    await exportStore.delete('feat:F252', pack.manifest.exportId);

    const retrieved = await exportStore.get('feat:F252', pack.manifest.exportId);
    assert.equal(retrieved, null);
  });

  test('delete non-existent export does not throw', async () => {
    // Should not throw — idempotent
    await exportStore.delete('feat:F252', 'nonexistent');
  });

  // ─── P0: exportId path traversal prevention ────────────────────

  test('exportId with path traversal characters is safely sanitized', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    await exportStore.create('feat:F252', 'Title', events, []);

    // Without sanitization, path.join(exportsDir, '../../../tmp/x') escapes
    // the data dir. With sanitization, '../../../tmp/x' → '______tmp_x'.
    const result = await exportStore.get('feat:F252', '../../../tmp/x');
    assert.equal(result, null, 'Traversal exportId should not find outside data dir');

    // delete() uses fs.rm(recursive, force) — if exportId were unsanitized,
    // this would delete real filesystem paths. After sanitization, it targets
    // a non-existent safe directory name inside the exports dir.
    await exportStore.delete('feat:F252', '../../../tmp/nonexistent-safe-test');
    // No assertion needed beyond "no throw" — traversal was neutralized.
  });

  test('delete with encoded traversal exportId stays contained', async () => {
    // Create a canary directory outside the store's data path
    const canaryDir = path.join(path.dirname(tmpDir), `export-traversal-canary-${process.pid}`);
    await fs.mkdir(canaryDir, { recursive: true });
    await fs.writeFile(path.join(canaryDir, 'alive.txt'), 'canary');

    try {
      // Attempt delete with path-traversing exportId
      // exportsDir = tmpDir/feat_F252/exports/, so ../../.. escapes tmpDir
      await exportStore.delete('feat:F252', `../../../${path.basename(canaryDir)}`);

      // Canary must survive — the traversal was neutralized by sanitization
      const stat = await fs.stat(path.join(canaryDir, 'alive.txt'));
      assert.ok(stat.isFile(), 'Canary file was deleted — exportId path traversal escaped!');
    } finally {
      await fs.rm(canaryDir, { recursive: true, force: true });
    }
  });

  // ─── INV-4: immutability ───────────────────────────────────────

  test('re-export creates new exportId, does not overwrite old', async () => {
    const events = [{ id: 'e1', at: 1000, kind: 'text', content: 'hello' }];
    const first = await exportStore.create('feat:F252', 'First', events, []);
    const second = await exportStore.create('feat:F252', 'Second', events, []);

    assert.notEqual(first.manifest.exportId, second.manifest.exportId);

    // Both retrievable
    const r1 = await exportStore.get('feat:F252', first.manifest.exportId);
    const r2 = await exportStore.get('feat:F252', second.manifest.exportId);
    assert.ok(r1);
    assert.ok(r2);
    assert.equal(r1.manifest.title, 'First');
    assert.equal(r2.manifest.title, 'Second');
  });
});
