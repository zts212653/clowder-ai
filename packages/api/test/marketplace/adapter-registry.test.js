// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('AdapterRegistry', () => {
  /** @type {import('../../dist/marketplace/adapter-registry.js').AdapterRegistry} */
  let registry;
  let AdapterRegistry;

  beforeEach(async () => {
    ({ AdapterRegistry } = await import('../../dist/marketplace/adapter-registry.js'));
    registry = new AdapterRegistry();
  });

  it('registers and retrieves adapters', () => {
    const mockAdapter = {
      ecosystem: 'claude',
      search: async () => [],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    };
    registry.register(mockAdapter);
    assert.strictEqual(registry.get('claude'), mockAdapter);
    assert.strictEqual(registry.get('codex'), undefined);
  });

  it('searches across all registered adapters', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => [makeResult({ artifactId: 'mcp-a', ecosystem: 'claude' })],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });
    registry.register({
      ecosystem: 'codex',
      search: async () => [makeResult({ artifactId: 'mcp-b', ecosystem: 'codex' })],
      buildInstallPlan: async () => ({ mode: 'delegated_cli' }),
    });

    const results = await registry.search({ query: 'test' });
    assert.strictEqual(results.length, 2);
    const ecosystems = results.map((r) => r.ecosystem);
    assert.ok(ecosystems.includes('claude'));
    assert.ok(ecosystems.includes('codex'));
  });

  it('filters by ecosystem', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => [makeResult({ ecosystem: 'claude' })],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });
    registry.register({
      ecosystem: 'codex',
      search: async () => [makeResult({ ecosystem: 'codex' })],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });

    const results = await registry.search({
      query: 'test',
      ecosystems: ['claude'],
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ecosystem, 'claude');
  });

  it('filters by trustLevel', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => [
        makeResult({ artifactId: 'a', trustLevel: 'official' }),
        makeResult({ artifactId: 'b', trustLevel: 'community' }),
      ],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });

    const results = await registry.search({
      query: 'test',
      trustLevels: ['official'],
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].trustLevel, 'official');
  });

  it('filters by artifactKind', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => [
        makeResult({ artifactId: 'a', artifactKind: 'mcp_server' }),
        makeResult({ artifactId: 'b', artifactKind: 'plugin' }),
      ],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });

    const results = await registry.search({
      query: 'test',
      artifactKinds: ['mcp_server'],
    });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].artifactKind, 'mcp_server');
  });

  it('respects limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => makeResult({ artifactId: `mcp-${i}` }));
    registry.register({
      ecosystem: 'claude',
      search: async () => items,
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });

    const results = await registry.search({ query: 'test', limit: 5 });
    assert.strictEqual(results.length, 5);
  });

  it('handles adapter errors gracefully — returns results from healthy adapters', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => {
        throw new Error('network error');
      },
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });
    registry.register({
      ecosystem: 'codex',
      search: async () => [makeResult({ ecosystem: 'codex' })],
      buildInstallPlan: async () => ({ mode: 'direct_mcp' }),
    });

    const results = await registry.search({ query: 'test' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].ecosystem, 'codex');
  });

  it('buildInstallPlan delegates to the correct adapter', async () => {
    registry.register({
      ecosystem: 'claude',
      search: async () => [],
      buildInstallPlan: async (id) => ({
        mode: 'direct_mcp',
        mcpEntry: { id },
      }),
    });

    const plan = await registry.buildInstallPlan('claude', 'my-mcp');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.strictEqual(plan.mcpEntry.id, 'my-mcp');
  });

  it('buildInstallPlan throws for unknown ecosystem', async () => {
    await assert.rejects(() => registry.buildInstallPlan('codex', 'x'), /No adapter/);
  });
});

function makeResult(overrides = {}) {
  return {
    artifactId: 'default-id',
    artifactKind: 'mcp_server',
    displayName: 'Default',
    ecosystem: 'claude',
    sourceLocator: 'https://example.com',
    trustLevel: 'official',
    componentSummary: 'A test tool',
    ...overrides,
  };
}
