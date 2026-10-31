// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('ClaudeMarketplaceAdapter', () => {
  let ClaudeMarketplaceAdapter;

  beforeEach(async () => {
    ({ ClaudeMarketplaceAdapter } = await import('../../../dist/marketplace/adapters/claude-adapter.js'));
  });

  it('has ecosystem = claude', () => {
    const adapter = new ClaudeMarketplaceAdapter({ catalogLoader: async () => [] });
    assert.strictEqual(adapter.ecosystem, 'claude');
  });

  it('searches catalog by keyword match in name/description/id', async () => {
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => [
        entry({ id: 'filesystem', name: 'Filesystem', description: 'Read and write files' }),
        entry({ id: 'github', name: 'GitHub', description: 'GitHub API integration' }),
        entry({ id: 'custom', name: 'Custom Tool', description: 'A community tool' }),
      ],
    });

    const byName = await adapter.search({ query: 'github' });
    assert.strictEqual(byName.length, 1);
    assert.strictEqual(byName[0].artifactId, 'github');

    const byDesc = await adapter.search({ query: 'write files' });
    assert.strictEqual(byDesc.length, 1);
    assert.strictEqual(byDesc[0].artifactId, 'filesystem');

    const byId = await adapter.search({ query: 'custom' });
    assert.strictEqual(byId.length, 1);
  });

  it('normalizes results to MarketplaceSearchResult shape', async () => {
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'fs',
          name: 'Filesystem',
          description: 'File ops',
          trustLevel: 'official',
          publisher: 'anthropic',
          versionRef: '1.0.0',
        }),
      ],
    });

    const [result] = await adapter.search({ query: 'fs' });
    assert.strictEqual(result.ecosystem, 'claude');
    assert.strictEqual(result.artifactKind, 'mcp_server');
    assert.strictEqual(result.trustLevel, 'official');
    assert.strictEqual(result.publisherIdentity, 'anthropic');
    assert.strictEqual(result.versionRef, '1.0.0');
  });

  it('builds direct_mcp install plan for stdio MCP', async () => {
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'filesystem',
          command: 'npx',
          args: ['-y', '@anthropic/mcp-filesystem'],
        }),
      ],
    });

    const plan = await adapter.buildInstallPlan('filesystem');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.ok(plan.mcpEntry);
    assert.strictEqual(plan.mcpEntry.id, 'filesystem');
    assert.strictEqual(plan.mcpEntry.command, 'npx');
    assert.deepStrictEqual(plan.mcpEntry.args, ['-y', '@anthropic/mcp-filesystem']);
  });

  it('builds direct_mcp install plan for streamableHttp MCP', async () => {
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'remote-api',
          url: 'https://mcp.example.com',
          transport: 'streamableHttp',
        }),
      ],
    });

    const plan = await adapter.buildInstallPlan('remote-api');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.strictEqual(plan.mcpEntry.url, 'https://mcp.example.com');
    assert.strictEqual(plan.mcpEntry.transport, 'streamableHttp');
  });

  it('includes env and headers in install plan', async () => {
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'envtest',
          env: { API_KEY: 'xxx' },
          headers: { Authorization: 'Bearer tok' },
          url: 'https://x.com',
          transport: 'streamableHttp',
        }),
      ],
    });

    const plan = await adapter.buildInstallPlan('envtest');
    assert.deepStrictEqual(plan.mcpEntry.env, { API_KEY: 'xxx' });
    assert.deepStrictEqual(plan.mcpEntry.headers, { Authorization: 'Bearer tok' });
  });

  it('throws for unknown artifactId', async () => {
    const adapter = new ClaudeMarketplaceAdapter({ catalogLoader: async () => [] });
    await assert.rejects(() => adapter.buildInstallPlan('nonexistent'), /not found/);
  });

  it('caches catalog after first load', async () => {
    let loadCount = 0;
    const adapter = new ClaudeMarketplaceAdapter({
      catalogLoader: async () => {
        loadCount++;
        return [entry({ id: 'test' })];
      },
    });

    await adapter.search({ query: 'test' });
    await adapter.search({ query: 'test' });
    assert.strictEqual(loadCount, 1);
  });
});

function entry(overrides = {}) {
  return {
    id: 'default',
    name: 'Default',
    description: 'Default desc',
    command: 'node',
    args: ['server.js'],
    trustLevel: 'official',
    publisher: 'test',
    ...overrides,
  };
}
