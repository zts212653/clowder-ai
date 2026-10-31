import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createAutoDreamServices } from '../dist/domains/auto-dream/AutoDreamServices.js';
import { LibraryCatalog } from '../dist/domains/memory/LibraryCatalog.js';

describe('createAutoDreamServices', () => {
  const tempRoots = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('registers world:diary as owner-private and reconciles the product store on startup', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-auto-dream-'));
    tempRoots.push(dataDir);
    const catalog = new LibraryCatalog();
    const stores = new Map();
    const services = await createAutoDreamServices({
      dataDir,
      privateUserId: ' owner-a ',
      catalog,
      collectionStores: stores,
    });

    try {
      const manifest = catalog.get('world:diary');
      assert.equal(manifest?.kind, 'world');
      assert.equal(manifest?.sensitivity, 'private');
      assert.equal(manifest?.ownerUserId, 'owner-a');
      assert.equal(stores.get('world:diary'), services.evidenceStore);
      assert.equal(
        catalog.getRoutable('library').some((item) => item.id === 'world:diary'),
        false,
      );
      assert.equal(catalog.getRoutable('collection', ['world:diary']).length, 0);
      assert.equal(catalog.getRoutable('collection', ['world:diary'], ['world:diary']).length, 1);
      assert.deepEqual(services.startupReconciliation, { projected: 0, removed: 0, failed: 0 });
    } finally {
      services.close();
    }
  });

  test('unbinds the private collection on close so a same-process restart can register cleanly', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-auto-dream-close-'));
    tempRoots.push(dataDir);
    const catalog = new LibraryCatalog();
    const stores = new Map();
    const services = await createAutoDreamServices({
      dataDir,
      privateUserId: 'owner-a',
      catalog,
      collectionStores: stores,
    });

    services.close();
    assert.equal(catalog.get('world:diary'), undefined);
    assert.equal(stores.has('world:diary'), false);
  });

  test('drains more than one projection batch on startup instead of leaving a diary ghost', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cat-cafe-auto-dream-reconcile-'));
    tempRoots.push(dataDir);
    const catalog = new LibraryCatalog();
    const stores = new Map();
    const initial = await createAutoDreamServices({
      dataDir,
      privateUserId: 'owner-a',
      catalog,
      collectionStores: stores,
    });

    for (let index = 0; index < 101; index += 1) {
      const run = await initial.store.beginRun({
        ownerUserId: 'owner-a',
        catId: 'codex-sol',
        threadId: 'thread-present-loop',
        taskId: `startup-reconcile-${index}`,
        firedAt: index + 1,
      });
      await initial.store.settleRun(
        {
          kind: 'invocation',
          invocationId: `invocation-${index}`,
          userId: 'owner-a',
          catId: 'codex-sol',
          threadId: 'thread-present-loop',
        },
        {
          runId: run.run.runId,
          outcome: 'diary',
          diary: {
            entryKind: 'souvenir',
            traceKind: 'non_work',
            localDate: '2026-07-16',
            headline: `startup diary ${index}`,
            summary: '等待启动修复的私人日记。',
            bodyMarkdown: `private diary body ${index}`,
            provenance: [{ kind: 'thread_message', refId: `message-${index}` }],
          },
        },
      );
    }
    assert.equal((await initial.store.listProjectionCandidates('owner-a', 200)).length, 101);
    initial.close();

    const restarted = await createAutoDreamServices({
      dataDir,
      privateUserId: 'owner-a',
      catalog,
      collectionStores: stores,
    });
    try {
      assert.deepEqual(restarted.startupReconciliation, { projected: 101, removed: 0, failed: 0 });
      assert.equal((await restarted.store.listProjectionCandidates('owner-a', 200)).length, 0);
    } finally {
      restarted.close();
    }
  });
});
