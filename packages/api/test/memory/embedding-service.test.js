import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('EmbeddingService', () => {
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

  it('getModelInfo returns config', async () => {
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
    assert.equal(info.modelRev, 'unknown');
  });

  it('embed throws when not loaded', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    await assert.rejects(() => svc.embed(['hello']), /not ready/i);
  });

  it('dispose is safe when not loaded', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc.dispose(); // should not throw
    assert.equal(svc.isReady(), false);
  });

  it('dispose sets isReady to false', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    // Manually set pipeline to simulate loaded state
    svc._setPipelineForTest('mock');
    assert.equal(svc.isReady(), true);
    svc.dispose();
    assert.equal(svc.isReady(), false);
  });

  it('load throws when memory guard exceeded', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 256,
      embedTimeoutMs: 3000,
      maxModelMemMb: 1, // 1MB — will definitely be exceeded
    });
    await assert.rejects(() => svc.load(), /memory guard/i);
    assert.equal(svc.isReady(), false);
  });

  it('embed applies MRL truncation and L2 normalization', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 2, // truncate to 2 dims for test
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    // Mock pipeline: returns a 4-dim embedding [3, 4, 0, 0]
    const mockOutput = {
      data: new Float32Array([3, 4, 0, 0]),
      dims: [1, 4],
    };
    svc._setPipelineForTest(async () => mockOutput);

    const [result] = await svc.embed(['test']);

    // MRL truncation: [3, 4] → L2 normalize: [3/5, 4/5] = [0.6, 0.8]
    assert.equal(result.length, 2);
    assert.ok(Math.abs(result[0] - 0.6) < 0.001, `expected ~0.6, got ${result[0]}`);
    assert.ok(Math.abs(result[1] - 0.8) < 0.001, `expected ~0.8, got ${result[1]}`);
  });

  it('embed respects timeout guard', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 2,
      embedTimeoutMs: 50, // 50ms timeout
      maxModelMemMb: 800,
    });

    // Mock pipeline that takes 500ms
    svc._setPipelineForTest(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { data: new Float32Array([1, 0]), dims: [1, 2] };
    });

    await assert.rejects(() => svc.embed(['slow']), /timeout/i);
  });

  it('embed handles multiple texts', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    // Mock: 2 texts, each 4-dim → [1,0,0,0, 0,1,0,0]
    const mockOutput = {
      data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0]),
      dims: [2, 4],
    };
    svc._setPipelineForTest(async () => mockOutput);

    const results = await svc.embed(['text1', 'text2']);
    assert.equal(results.length, 2);
    assert.equal(results[0].length, 2);
    assert.equal(results[1].length, 2);
    // First: [1,0] normalized = [1,0]
    assert.ok(Math.abs(results[0][0] - 1.0) < 0.001);
    // Second: [0,1] normalized = [0,1]
    assert.ok(Math.abs(results[1][1] - 1.0) < 0.001);
  });

  it('singleflight: concurrent load() calls only load once (P3)', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    let loadCount = 0;
    const svc = new EmbeddingService({
      embedModel: 'qwen3-embedding-0.6b',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    // Override internal _doLoad to count invocations
    svc._setLoaderForTest(async () => {
      loadCount++;
      await new Promise((r) => setTimeout(r, 50));
    });

    // Fire two concurrent loads
    await Promise.all([svc.load(), svc.load()]);
    assert.equal(loadCount, 1, 'load should only be called once (singleflight)');
  });
});
