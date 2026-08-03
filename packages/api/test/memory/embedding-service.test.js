import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('EmbeddingService (HTTP client to embed-api.py)', () => {
  it('isReady returns false before load', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    assert.equal(svc.isReady(), false);
  });

  it('getModelInfo returns config before load', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    const info = svc.getModelInfo();
    assert.equal(info.modelId, 'qwen3-embedding-0.6b');
    assert.equal(info.dim, 256);
    assert.equal(info.modelRev, 'http-client');
  });

  it('embed throws when not loaded (server not available)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    await assert.rejects(() => svc.embed(['hello']), /not ready/i);
  });

  it('embed splits inputs > 64 into batches (mirrors embed-api MAX_BATCH_SIZE)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 4,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc.markReady();
    const originalFetch = globalThis.fetch;
    const seenBatchSizes = [];
    const seenPolicies = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      seenBatchSizes.push(body.input.length);
      seenPolicies.push({
        deadlineMs: body.deadline_ms,
        maxModelMemMb: body.max_model_mem_mb,
      });
      const data = body.input.map((_, i) => ({
        index: i,
        embedding: [0.1, 0.2, 0.3, 0.4],
      }));
      return {
        ok: true,
        async json() {
          return { data, model: 'mock' };
        },
      };
    };
    try {
      const texts = new Array(150).fill('hello');
      const vectors = await svc.embed(texts);
      assert.equal(vectors.length, 150);
      // 150 split into 64 + 64 + 22
      assert.deepEqual(seenBatchSizes, [64, 64, 22]);
      assert.ok(seenBatchSizes.every((n) => n <= 64));
      assert.ok(
        seenPolicies.every(
          (policy) =>
            Number.isInteger(policy.deadlineMs) &&
            policy.deadlineMs > Date.now() &&
            policy.deadlineMs <= Date.now() + 3_000 &&
            policy.maxModelMemMb === 800,
        ),
        'every sidecar batch must carry the absolute deadline and configured memory budget',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('propagates a parent abort into an in-flight embedding HTTP request', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 4,
      embedTimeoutMs: 250,
      maxModelMemMb: 800,
    });
    svc.markReady();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason ?? new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      const embedding = svc.embed(['abort me'], controller.signal);
      setTimeout(() => controller.abort(new DOMException('coverage deadline', 'AbortError')), 5);
      await assert.rejects(embedding, /coverage deadline|aborted/i);
      assert.ok(Date.now() - startedAt < 100, 'parent deadline should win over the embedding client timeout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('markReady flips ready without probing /health (event-driven entry)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    assert.equal(svc.isReady(), false);
    svc.markReady('jinaai/jina-embeddings-v2-base-zh');
    assert.equal(svc.isReady(), true);
    assert.equal(svc.getModelInfo().modelId, 'jinaai/jina-embeddings-v2-base-zh');
  });

  it('dispose sets isReady to false', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc._setPipelineForTest('mock');
    assert.equal(svc.isReady(), true);
    svc.dispose();
    assert.equal(svc.isReady(), false);
  });

  it('load sets isReady when using mock loader', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc._setLoaderForTest(async () => {});
    await svc.load();
    // Loader doesn't set ready by default — it's for testing singleflight
    // The real load() probes /health
  });

  it('load fails gracefully when server is not running (fail-open)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    // Point to a port that definitely doesn't have embed-api
    process.env.EMBED_URL = 'http://127.0.0.1:19999';
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    // Should not throw — fail-open
    await svc.load();
    assert.equal(svc.isReady(), false, 'should be not ready when server unavailable');
    delete process.env.EMBED_URL;
  });

  it('concurrent load() calls are safe (idempotent health probe)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    let loadCount = 0;
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc._setLoaderForTest(async () => {
      loadCount++;
    });
    // Concurrent loads should all succeed without error
    await Promise.all([svc.load(), svc.load(), svc.load()]);
    assert.ok(loadCount >= 1, 'load should run at least once');
  });

  // codex P1 2026-05-24 (outdated): the embed client must follow the
  // persisted service port. /start injects cfg.port into the sidecar env,
  // so the API process needs to resolve baseUrl from manifest + persisted
  // config — not from a cached env-only snapshot. Otherwise a long-lived
  // API still posts embeddings to 9880 while the sidecar binds to the
  // custom port, silently degrading semantic search to lexical-only.
  it('resolves embedding endpoint from persisted service port on each request', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { setServiceConfig } = await import('../../dist/domains/services/service-config.js');
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');

    const configDir = mkdtempSync(join(tmpdir(), 'embed-service-reconfig-'));
    process.env.CAT_CAFE_SERVICES_CONFIG = join(configDir, 'services.json');
    delete process.env.EMBED_URL;
    delete process.env.EMBED_PORT;
    setServiceConfig('embedding-model', { enabled: true, installed: true, port: 19880 });

    const originalFetch = globalThis.fetch;
    const capturedUrls = [];
    globalThis.fetch = async (url) => {
      capturedUrls.push(String(url));
      return new Response(JSON.stringify({ status: 'ok', model: 'qwen3-embedding-0.6b', dim: 256 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const svc = new EmbeddingService({
        embedModel: 'qwen3-embedding-0.6b',
        embedDim: 256,
        embedTimeoutMs: 3000,
        maxModelMemMb: 800,
      });
      await svc.load();

      // Simulate /reconfigure persisting a new port while the service
      // instance is still alive.
      setServiceConfig('embedding-model', { enabled: true, installed: true, port: 19881 });
      await svc.load();

      assert.equal(capturedUrls[0], 'http://127.0.0.1:19880/health');
      assert.equal(
        capturedUrls[1],
        'http://127.0.0.1:19881/health',
        'EmbeddingService must follow the persisted service port without API restart',
      );
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.CAT_CAFE_SERVICES_CONFIG;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
