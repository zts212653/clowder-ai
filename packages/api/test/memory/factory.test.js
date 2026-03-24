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

  it('embedMode=on creates embedding service (HTTP client, fail-open)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    // EmbeddingService is now an HTTP client (PR #608, LL-034).
    // load() probes embed-api /health — may succeed if sidecar is running,
    // or fail-open if not. Either way, factory should NOT throw.
    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'on' },
    });

    // EmbeddingService should exist regardless of sidecar status
    assert.ok(services.embeddingService, 'embeddingService should exist');
    // isReady() depends on whether embed-api sidecar is running — both are valid
    // The important thing is that factory didn't throw
  });
});
