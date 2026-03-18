import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('createMemoryServices', () => {
  it('creates sqlite services', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: '/tmp/f102-test-docs',
      markersDir: '/tmp/f102-test-markers',
    });

    assert.ok(services.evidenceStore);
    assert.ok(services.markerQueue);
    assert.ok(services.reflectionService);
    assert.ok(services.knowledgeResolver);
    assert.ok(services.indexBuilder);
    assert.ok(services.materializationService);

    assert.equal(await services.evidenceStore.health(), true);
  });

  // ── Phase C: embed config integration ───────────────────────────

  it('embedMode=off creates no embedding service', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'off' },
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('embedMode defaults to off when embed not specified', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('embedMode=on creates embedding service (fail-open on load)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    // In test env: load() will fail (no @huggingface/transformers or memory guard)
    // Factory should NOT throw — fail-open pattern
    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'on', maxModelMemMb: 1 }, // 1MB guard will trigger
    });

    // EmbeddingService was created but load() failed → isReady()=false
    assert.ok(services.embeddingService, 'embeddingService should exist');
    assert.equal(services.embeddingService.isReady(), false, 'should not be ready after failed load');
    // vectorStore may or may not exist depending on sqlite-vec availability
  });
});
