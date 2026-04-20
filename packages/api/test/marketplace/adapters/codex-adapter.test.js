// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('CodexMarketplaceAdapter', () => {
  let CodexMarketplaceAdapter;

  beforeEach(async () => {
    ({ CodexMarketplaceAdapter } = await import('../../../dist/marketplace/adapters/codex-adapter.js'));
  });

  it('has ecosystem = codex', () => {
    const adapter = new CodexMarketplaceAdapter({ catalogLoader: async () => [] });
    assert.strictEqual(adapter.ecosystem, 'codex');
  });

  it('normalizes env_vars → env in install plan', async () => {
    const adapter = new CodexMarketplaceAdapter({
      catalogLoader: async () => [entry({ id: 'tool', env_vars: { API_KEY: 'xxx' } })],
    });
    const plan = await adapter.buildInstallPlan('tool');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.deepStrictEqual(plan.mcpEntry.env, { API_KEY: 'xxx' });
  });

  it('maps serverUrl → url + streamableHttp transport', async () => {
    const adapter = new CodexMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'remote',
          serverUrl: 'https://mcp.openai.com/v1',
          env_http_headers: { Authorization: 'Bearer tok' },
        }),
      ],
    });
    const plan = await adapter.buildInstallPlan('remote');
    assert.strictEqual(plan.mcpEntry.url, 'https://mcp.openai.com/v1');
    assert.strictEqual(plan.mcpEntry.transport, 'streamableHttp');
    assert.deepStrictEqual(plan.mcpEntry.headers, { Authorization: 'Bearer tok' });
  });

  it('generates delegated_cli for plugin-type entries', async () => {
    const adapter = new CodexMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'codex-plugin',
          kind: 'plugin',
          cliInstallCommand: 'codex plugin install codex-plugin',
        }),
      ],
    });
    const plan = await adapter.buildInstallPlan('codex-plugin');
    assert.strictEqual(plan.mode, 'delegated_cli');
    assert.strictEqual(plan.delegatedCommand, 'codex plugin install codex-plugin');
  });

  it('search result distinguishes mcp_server vs plugin', async () => {
    const adapter = new CodexMarketplaceAdapter({
      catalogLoader: async () => [
        entry({ id: 'mcp', kind: 'mcp_server' }),
        entry({ id: 'plug', kind: 'plugin', name: 'Plugin' }),
      ],
    });
    const results = await adapter.search({ query: '' });
    assert.strictEqual(results.find((r) => r.artifactId === 'mcp').artifactKind, 'mcp_server');
    assert.strictEqual(results.find((r) => r.artifactId === 'plug').artifactKind, 'plugin');
  });

  it('throws for unknown artifactId', async () => {
    const adapter = new CodexMarketplaceAdapter({ catalogLoader: async () => [] });
    await assert.rejects(() => adapter.buildInstallPlan('nope'), /not found/);
  });
});

function entry(overrides = {}) {
  return {
    id: 'default',
    name: 'Default',
    description: 'Default desc',
    command: 'python',
    args: ['-m', 'server'],
    trustLevel: 'verified',
    publisher: 'openai',
    ...overrides,
  };
}
