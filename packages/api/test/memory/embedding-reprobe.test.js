import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('EmbeddingService reprobeIfNeeded (bug #2: isReady permanently false)', () => {
  it('recovers when embed-api becomes available after initial failure', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'test-model',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    let serverUp = false;
    svc._setLoaderForTest(async () => {
      if (!serverUp) return;
      svc._setPipelineForTest('mock');
    });
    await svc.load();
    assert.equal(svc.isReady(), false, 'initially not ready');

    serverUp = true;
    await svc.reprobeIfNeeded();
    assert.equal(svc.isReady(), true, 'should be ready after reprobe');
  });

  it('is a no-op when already ready', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'test-model',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });
    svc._setPipelineForTest('mock');
    assert.equal(svc.isReady(), true);

    let loadCalled = false;
    svc._setLoaderForTest(async () => {
      loadCalled = true;
    });
    await svc.reprobeIfNeeded();

    assert.equal(loadCalled, false, 'should not re-probe when already ready');
  });

  it('respects cooldown period between reprobe attempts', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'test-model',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    let loadCount = 0;
    svc._setLoaderForTest(async () => {
      loadCount++;
    });
    await svc.load();
    assert.equal(loadCount, 1);

    await svc.reprobeIfNeeded();
    assert.equal(loadCount, 2, 'first reprobe should call load');

    await svc.reprobeIfNeeded();
    assert.equal(loadCount, 2, 'second reprobe within cooldown should be skipped');
  });
});
