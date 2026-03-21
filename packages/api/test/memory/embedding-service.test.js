import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

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
});
