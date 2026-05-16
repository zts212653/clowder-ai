import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('embedIndexedItems (shared utility with batch splitting)', () => {
  it('splits >64 items into batches of 64', async () => {
    const { embedIndexedItems } = await import('../../dist/domains/memory/embed-utils.js');

    const batchSizes = [];
    const mockEmbedding = {
      isReady: () => true,
      reprobeIfNeeded: async () => {},
      embed: async (texts) => {
        batchSizes.push(texts.length);
        return texts.map(() => new Float32Array([0.1, 0.2]));
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 2 }),
    };

    const upserted = [];
    const mockVectorStore = {
      upsert: (anchor, vec) => upserted.push({ anchor, vec }),
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      initMeta: () => {},
    };

    const items = Array.from({ length: 150 }, (_, i) => ({
      anchor: `doc-${i}`,
      title: `Doc ${i}`,
      summary: `Summary ${i}`,
    }));

    await embedIndexedItems(items, mockEmbedding, mockVectorStore);

    assert.equal(upserted.length, 150, 'all 150 items should be embedded');
    assert.ok(
      batchSizes.every((s) => s <= 64),
      `no batch should exceed 64, got: ${batchSizes}`,
    );
    assert.equal(batchSizes.length, 3, 'should split 150 into 3 batches (64+64+22)');
  });

  it('handles exactly 64 items in single batch', async () => {
    const { embedIndexedItems } = await import('../../dist/domains/memory/embed-utils.js');

    let callCount = 0;
    const mockEmbedding = {
      isReady: () => true,
      reprobeIfNeeded: async () => {},
      embed: async (texts) => {
        callCount++;
        return texts.map(() => new Float32Array([0.1]));
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 1 }),
    };

    const mockVectorStore = {
      upsert: () => {},
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      initMeta: () => {},
    };

    const items = Array.from({ length: 64 }, (_, i) => ({
      anchor: `doc-${i}`,
      title: `Doc ${i}`,
    }));

    await embedIndexedItems(items, mockEmbedding, mockVectorStore);
    assert.equal(callCount, 1, 'exactly 64 items should be one batch');
  });

  it('skips when embedding service not ready and reprobe fails', async () => {
    const { embedIndexedItems } = await import('../../dist/domains/memory/embed-utils.js');

    let embedCalled = false;
    const mockEmbedding = {
      isReady: () => false,
      reprobeIfNeeded: async () => {},
      embed: async () => {
        embedCalled = true;
        return [];
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 1 }),
    };

    const mockVectorStore = {
      upsert: () => {},
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      initMeta: () => {},
    };

    await embedIndexedItems([{ anchor: 'a', title: 'A' }], mockEmbedding, mockVectorStore);
    assert.equal(embedCalled, false, 'should not call embed when service not ready');
  });

  it('skips empty items array without calling reprobeIfNeeded', async () => {
    const { embedIndexedItems } = await import('../../dist/domains/memory/embed-utils.js');

    let reprobeCalled = false;
    const mockEmbedding = {
      isReady: () => true,
      reprobeIfNeeded: async () => {
        reprobeCalled = true;
      },
      embed: async () => {
        return [];
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 1 }),
    };

    const mockVectorStore = {
      upsert: () => {},
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      initMeta: () => {},
    };

    await embedIndexedItems([], mockEmbedding, mockVectorStore);
    assert.equal(reprobeCalled, false, 'should not call reprobeIfNeeded for empty array');
  });

  it('recovers via reprobeIfNeeded when embed-api starts late (bug #2)', async () => {
    const { embedIndexedItems } = await import('../../dist/domains/memory/embed-utils.js');

    let ready = false;
    const mockEmbedding = {
      isReady: () => ready,
      reprobeIfNeeded: async () => {
        ready = true;
      },
      embed: async (texts) => texts.map(() => new Float32Array([0.1])),
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 1 }),
    };

    const upserted = [];
    const mockVectorStore = {
      upsert: (anchor, vec) => upserted.push(anchor),
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      initMeta: () => {},
    };

    await embedIndexedItems([{ anchor: 'doc-1', title: 'Doc 1' }], mockEmbedding, mockVectorStore);
    assert.equal(upserted.length, 1, 'should embed after reprobe recovers ready state');
  });
});
