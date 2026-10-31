import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test('activation while the source read awaits cannot capture an absent-vector no-op for a later write', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vector-admission-race-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const messages = [{ id: 'one', threadId: 'stable', content: 'Old input', timestamp: 1000 }];
  const thread = { id: 'stable', title: 'Stable', lastActiveAt: 1000, participants: [] };
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let blocked = false;
  const builder = new IndexBuilder(
    store,
    root,
    undefined,
    undefined,
    () => [thread],
    async () => {
      if (blocked) {
        entered();
        await gate;
      }
      return messages;
    },
  );
  await builder.rebuild();
  messages[0].content = 'New input';
  blocked = true;
  const refresh = builder.indexPassages([thread]);
  await started;
  const lifecycle = new MemoryEmbeddingLifecycle(
    store,
    builder,
    {
      embedMode: 'off',
      embedModel: 'fixture',
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    {
      createEmbeddingService: () => ({
        load: async () => {},
        dispose() {},
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }),
        embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      }),
    },
  );
  t.after(() => lifecycle.deactivate());
  assert.equal((await lifecycle.activate('on')).ok, true);
  await builder.embedMissingPassages(['thread-stable']);
  assert.equal(lifecycle.getPassageVectorStore().count(), 1, 'warmup sampled the old persisted input');
  release();
  await refresh;
  assert.equal(
    lifecycle.getPassageVectorStore().count(),
    0,
    'new input must invalidate after entering the writer queue',
  );
});
