import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

async function createLifecycleHarness(options) {
  const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
  const { MemoryEmbeddingLifecycle } = await import('../../dist/domains/memory/MemoryEmbeddingLifecycle.js');
  const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
  const root = mkdtempSync(join(tmpdir(), 'embedding-lifecycle-unit-'));
  const docsRoot = join(root, 'docs');
  mkdirSync(join(docsRoot, 'features'), { recursive: true });
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const builder = new IndexBuilder(store, docsRoot);
  const lifecycle = new MemoryEmbeddingLifecycle(
    store,
    builder,
    {
      embedMode: 'off',
      embedModel: 'test-model',
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    options,
  );
  return {
    lifecycle,
    store,
    cleanup() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeEmbeddingService(load) {
  let ready = false;
  return {
    load: async () => {
      ready = await load();
    },
    embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    isReady: () => ready,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ modelId: 'test-model', modelRev: 'test', dim: 4 }),
    dispose: () => {
      ready = false;
    },
  };
}

describe('MemoryEmbeddingLifecycle', () => {
  it('activates vector indexing after the API starts with embedding off', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const root = mkdtempSync(join(tmpdir(), 'embedding-lifecycle-'));
    const docsRoot = join(root, 'docs');
    mkdirSync(join(docsRoot, 'features'), { recursive: true });
    writeFileSync(
      join(docsRoot, 'features', 'F999-lifecycle.md'),
      `---
feature_ids: [F999]
topics: [memory, embedding]
doc_kind: spec
---

# F999: Runtime embedding lifecycle

The local embedding service can become ready after API startup.
`,
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/health')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            model: 'jinaai/jina-embeddings-v2-base-zh',
            backend: 'test',
            device: 'cpu',
            dim: 4,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(url).endsWith('/v1/embeddings')) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: 'jinaai/jina-embeddings-v2-base-zh',
            data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected embedding request: ${url}`);
    };

    let services;
    try {
      services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: ':memory:',
        docsRoot,
        markersDir: join(root, 'markers'),
        globalDbPath: ':memory:',
        skillsRoot: join(root, 'skills'),
        memoryRoot: join(root, 'memory'),
        dataDir: join(root, 'data'),
        embed: { embedMode: 'off', embedDim: 4 },
      });

      assert.equal(services.embeddingService, undefined, 'off startup must stay lightweight');
      assert.ok(services.embeddingLifecycle, 'factory must expose a runtime lifecycle controller');

      const activation = await services.embeddingLifecycle.activate('on');
      assert.deepEqual(activation, { ok: true, status: 'ready', mode: 'on' });
      assert.equal(services.embeddingLifecycle.getService()?.isReady(), true);
      assert.ok(services.embeddingLifecycle.getVectorStore());
      assert.ok(services.embeddingLifecycle.getPassageVectorStore());

      const result = await services.indexBuilder.rebuild({ force: true });
      assert.equal(result.docsIndexed, 1);
      assert.equal(services.embeddingLifecycle.getVectorStore().count(), 1);

      services.embeddingLifecycle.deactivate();
      assert.equal(services.embeddingLifecycle.getMode(), 'off');
      assert.equal(services.embeddingLifecycle.getService(), undefined);
      assert.equal(
        services.store.getDb().prepare('SELECT count(*) AS c FROM evidence_vectors').get().c,
        1,
        'deactivation must retain stored vectors',
      );
    } finally {
      globalThis.fetch = originalFetch;
      services?.store.close();
      services?.globalStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clears embedding dependencies from registered external stores when disabled', async () => {
    const dependentCalls = [];
    const dependentStore = {
      setEmbedDeps: (deps) => dependentCalls.push(deps),
    };
    const harness = await createLifecycleHarness({
      createEmbeddingService: () => makeEmbeddingService(async () => true),
      initializeVectorBackend: async () => ({ vectorStore: {}, passageVectorStore: {} }),
      getDependentStores: () => [dependentStore],
    });
    try {
      assert.deepEqual(await harness.lifecycle.activate('on'), { ok: true, status: 'ready', mode: 'on' });
      harness.lifecycle.deactivate();
      assert.deepEqual(dependentCalls, [undefined]);
    } finally {
      harness.cleanup();
    }
  });

  it('serializes concurrent activation events into one dependency build', async () => {
    let loadCount = 0;
    let backendCount = 0;
    const service = makeEmbeddingService(async () => {
      loadCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return true;
    });
    const backend = { vectorStore: {}, passageVectorStore: {} };
    const harness = await createLifecycleHarness({
      createEmbeddingService: () => service,
      initializeVectorBackend: async () => {
        backendCount += 1;
        return backend;
      },
    });
    try {
      const results = await Promise.all([
        harness.lifecycle.activate('on'),
        harness.lifecycle.activate('on'),
        harness.lifecycle.activate('on'),
      ]);
      assert.ok(results.every((result) => result.ok));
      assert.equal(loadCount, 1);
      assert.equal(backendCount, 1);
    } finally {
      harness.cleanup();
    }
  });

  it('restores ready dependencies on API restart with embedding enabled', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const root = mkdtempSync(join(tmpdir(), 'embedding-lifecycle-restart-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (!String(url).endsWith('/health')) throw new Error(`Unexpected request: ${url}`);
      return new Response(
        JSON.stringify({ status: 'ok', model: 'test-model', backend: 'test', device: 'cpu', dim: 4 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    let services;
    try {
      services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: ':memory:',
        docsRoot: join(root, 'docs'),
        markersDir: join(root, 'markers'),
        globalDbPath: ':memory:',
        skillsRoot: join(root, 'skills'),
        memoryRoot: join(root, 'memory'),
        dataDir: join(root, 'data'),
        embed: { embedMode: 'on', embedDim: 4 },
      });
      assert.equal(services.embeddingLifecycle.getStatus(), 'ready');
      assert.equal(services.embeddingService?.isReady(), true);
      assert.ok(services.vectorStore);
      assert.ok(services.passageVectorStore);
    } finally {
      globalThis.fetch = originalFetch;
      services?.store.close();
      services?.globalStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a configured service after a later ready event', async () => {
    let probeCount = 0;
    const service = makeEmbeddingService(async () => {
      probeCount += 1;
      return probeCount > 1;
    });
    const harness = await createLifecycleHarness({
      createEmbeddingService: () => service,
      initializeVectorBackend: async () => ({ vectorStore: {}, passageVectorStore: {} }),
    });
    try {
      assert.deepEqual(await harness.lifecycle.activate('on'), {
        ok: false,
        status: 'configured',
        mode: 'on',
        reason: 'service_not_ready',
      });
      assert.deepEqual(await harness.lifecycle.activate('on'), { ok: true, status: 'ready', mode: 'on' });
      assert.equal(probeCount, 2);
    } finally {
      harness.cleanup();
    }
  });

  it('degrades visibly when sqlite-vec cannot be initialized', async () => {
    const harness = await createLifecycleHarness({
      createEmbeddingService: () => makeEmbeddingService(async () => true),
      initializeVectorBackend: async () => {
        throw new Error('unsupported platform');
      },
    });
    try {
      assert.deepEqual(await harness.lifecycle.activate('on'), {
        ok: false,
        status: 'degraded',
        mode: 'on',
        reason: 'sqlite_vec_unavailable',
      });
      assert.equal(harness.lifecycle.getFailureReason(), 'sqlite_vec_unavailable');
      assert.equal(harness.lifecycle.getVectorStore(), undefined);
    } finally {
      harness.cleanup();
    }
  });

  it('can reactivate while an obsolete activation is still settling', async () => {
    let releaseFirst = () => {};
    const firstProbe = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let serviceCount = 0;
    const harness = await createLifecycleHarness({
      createEmbeddingService: () => {
        serviceCount += 1;
        return makeEmbeddingService(async () => {
          if (serviceCount === 1) await firstProbe;
          return true;
        });
      },
      initializeVectorBackend: async () => ({ vectorStore: {}, passageVectorStore: {} }),
    });
    try {
      const obsolete = harness.lifecycle.activate('on');
      harness.lifecycle.deactivate();
      const current = harness.lifecycle.activate('on');
      releaseFirst();

      assert.deepEqual(await current, { ok: true, status: 'ready', mode: 'on' });
      await obsolete;
      assert.equal(harness.lifecycle.getStatus(), 'ready');
      assert.equal(serviceCount, 2);
    } finally {
      releaseFirst();
      harness.cleanup();
    }
  });
});
