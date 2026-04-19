// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

describe('Marketplace Routes', () => {
  let app;

  before(async () => {
    const { default: Fastify } = await import('fastify');
    const { AdapterRegistry } = await import('../../dist/marketplace/adapter-registry.js');
    const { ClaudeMarketplaceAdapter } = await import('../../dist/marketplace/adapters/claude-adapter.js');
    const { AntigravityMarketplaceAdapter } = await import('../../dist/marketplace/adapters/antigravity-adapter.js');
    const { marketplaceRoutes } = await import('../../dist/routes/marketplace.js');

    const registry = new AdapterRegistry();
    registry.register(
      new ClaudeMarketplaceAdapter({
        catalogLoader: async () => [
          {
            id: 'mcp-memory',
            name: 'Memory Server',
            description: 'Persistent memory via MCP',
            command: 'npx',
            args: ['-y', '@anthropic/mcp-memory'],
            trustLevel: 'official',
            publisher: 'anthropic',
          },
          {
            id: 'mcp-fetch',
            name: 'Fetch Server',
            description: 'HTTP fetch via MCP',
            command: 'npx',
            args: ['-y', '@anthropic/mcp-fetch'],
            trustLevel: 'verified',
            publisher: 'community-dev',
          },
        ],
      }),
    );
    registry.register(
      new AntigravityMarketplaceAdapter({
        catalogLoader: async () => [
          {
            id: 'ag-ext-1',
            name: 'AG Extension',
            description: 'An Antigravity extension',
            trustLevel: 'official',
            publisher: 'antigravity',
          },
        ],
      }),
    );

    app = Fastify();
    await app.register(marketplaceRoutes, { registry });
    await app.ready();
  });

  after(async () => {
    if (app) await app.close();
  });

  it('GET /api/marketplace/search returns results for query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/search?q=memory',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length > 0);
    assert.ok(body.results.some((r) => r.artifactId === 'mcp-memory'));
  });

  it('GET /api/marketplace/search filters by ecosystem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/search?q=extension&ecosystems=antigravity',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    for (const r of body.results) {
      assert.strictEqual(r.ecosystem, 'antigravity');
    }
  });

  it('GET /api/marketplace/search filters by trustLevel', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/search?q=server&trustLevels=official',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    for (const r of body.results) {
      assert.strictEqual(r.trustLevel, 'official');
    }
  });

  it('GET /api/marketplace/search returns 400 without q param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/marketplace/search',
    });
    assert.strictEqual(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('q'));
  });

  it('POST /api/marketplace/install/plan returns install plan', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/install/plan',
      payload: { ecosystem: 'claude', artifactId: 'mcp-memory' },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json();
    assert.strictEqual(body.plan.mode, 'direct_mcp');
    assert.ok(body.plan.mcpEntry);
    assert.strictEqual(body.plan.mcpEntry.id, 'mcp-memory');
  });

  it('POST /api/marketplace/install/plan returns 404 for unknown artifact', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/install/plan',
      payload: { ecosystem: 'claude', artifactId: 'nonexistent' },
    });
    assert.strictEqual(res.statusCode, 404);
  });

  it('POST /api/marketplace/install/plan returns 400 for missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/install/plan',
      payload: { ecosystem: 'claude' },
    });
    assert.strictEqual(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('artifactId'));
  });

  it('POST /api/marketplace/install/plan returns 400 for unknown ecosystem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/marketplace/install/plan',
      payload: { ecosystem: 'unknown', artifactId: 'test' },
    });
    assert.strictEqual(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.error.includes('adapter') || body.error.includes('No adapter'));
  });
});
