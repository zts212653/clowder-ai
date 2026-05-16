import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('EmbeddingService reprobe (bug #2: isReady permanently false)', () => {
  it('reprobeIfNeeded recovers when embed-api becomes available after initial failure', async () => {
    const { EmbeddingService } = await import('../../dist/domains/memory/EmbeddingService.js');
    const svc = new EmbeddingService({
      embedModel: 'test-model',
      embedDim: 2,
      embedTimeoutMs: 3000,
      maxModelMemMb: 800,
    });

    // Simulate initial load failure (embed-api not yet started)
    let serverUp = false;
    svc._setLoaderForTest(async () => {
      if (!serverUp) return; // stays not ready
      svc._setPipelineForTest('mock'); // mark ready
    });
    await svc.load();
    assert.equal(svc.isReady(), false, 'initially not ready');

    // Now embed-api starts
    serverUp = true;

    // reprobeIfNeeded should re-check and recover
    await svc.reprobeIfNeeded();
    assert.equal(svc.isReady(), true, 'should be ready after reprobe');
  });

  it('reprobeIfNeeded is a no-op when already ready', async () => {
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
    assert.equal(svc.isReady(), true);
  });
});
