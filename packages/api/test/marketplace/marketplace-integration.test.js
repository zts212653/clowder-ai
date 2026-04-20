// @ts-check
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('Marketplace Integration: search → installPlan → McpInstallRequest', () => {
  let createAdapterRegistry, toMcpInstallRequest, validateInstallPlan;

  before(async () => {
    ({ createAdapterRegistry } = await import('../../dist/marketplace/index.js'));
    ({ toMcpInstallRequest, validateInstallPlan } = await import('../../dist/marketplace/install-plan-bridge.js'));
  });

  it('Claude: search → direct_mcp plan → McpInstallRequest (stdio)', async () => {
    const registry = createAdapterRegistry({
      claude: {
        catalogLoader: async () => [
          {
            id: 'mcp-memory',
            name: 'Memory Server',
            description: 'Persistent memory',
            command: 'npx',
            args: ['-y', '@anthropic/mcp-memory'],
            trustLevel: 'official',
            publisher: 'anthropic',
            versionRef: '1.2.0',
          },
        ],
      },
    });

    const results = await registry.search({ query: 'memory' });
    assert.ok(results.length > 0);
    const hit = results.find((r) => r.artifactId === 'mcp-memory');
    assert.ok(hit);
    assert.strictEqual(hit.ecosystem, 'claude');

    const plan = await registry.buildInstallPlan('claude', 'mcp-memory');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.deepStrictEqual(validateInstallPlan(plan), []);

    const req = toMcpInstallRequest(plan);
    assert.strictEqual(req.id, 'mcp-memory');
    assert.strictEqual(req.command, 'npx');
    assert.deepStrictEqual(req.args, ['-y', '@anthropic/mcp-memory']);
  });

  it('Claude: streamableHttp preserves url + transport through the chain', async () => {
    const registry = createAdapterRegistry({
      claude: {
        catalogLoader: async () => [
          {
            id: 'remote-mcp',
            name: 'Remote Server',
            description: 'SSE remote',
            url: 'https://api.example.com/mcp',
            transport: 'streamableHttp',
            headers: { Authorization: 'Bearer tok' },
            trustLevel: 'verified',
            publisher: 'example',
          },
        ],
      },
    });

    const plan = await registry.buildInstallPlan('claude', 'remote-mcp');
    const req = toMcpInstallRequest(plan);
    assert.strictEqual(req.url, 'https://api.example.com/mcp');
    assert.strictEqual(req.transport, 'streamableHttp');
    assert.deepStrictEqual(req.headers, { Authorization: 'Bearer tok' });
  });

  it('Codex: env_vars normalized to env in McpInstallRequest', async () => {
    const registry = createAdapterRegistry({
      codex: {
        catalogLoader: async () => [
          {
            id: 'codex-tool',
            name: 'Codex Tool',
            description: 'A Codex MCP server',
            command: 'npx',
            args: ['codex-mcp'],
            env_vars: { API_KEY: 'xxx' },
            type: 'mcp_server',
            trustLevel: 'official',
            publisher: 'openai',
          },
        ],
      },
    });

    const plan = await registry.buildInstallPlan('codex', 'codex-tool');
    assert.strictEqual(plan.mode, 'direct_mcp');
    const req = toMcpInstallRequest(plan);
    assert.deepStrictEqual(req.env, { API_KEY: 'xxx' });
  });

  it('Antigravity: read-only → manual_ui plan (not bridgeable to McpInstallRequest)', async () => {
    const registry = createAdapterRegistry({
      antigravity: {
        catalogLoader: async () => [
          {
            id: 'ag-ext',
            name: 'AG Extension',
            description: 'Antigravity extension',
            trustLevel: 'official',
            publisher: 'antigravity',
          },
        ],
      },
    });

    const plan = await registry.buildInstallPlan('antigravity', 'ag-ext');
    assert.strictEqual(plan.mode, 'manual_ui');
    assert.ok(plan.manualSteps.length > 0);
    assert.throws(() => toMcpInstallRequest(plan), /only supports direct_mcp/);
  });

  it('multi-ecosystem search returns results from all registered adapters', async () => {
    const registry = createAdapterRegistry({
      claude: {
        catalogLoader: async () => [
          {
            id: 'claude-server',
            name: 'Claude MCP Server',
            description: 'Claude ecosystem',
            command: 'npx',
            args: ['claude-mcp'],
            trustLevel: 'official',
            publisher: 'anthropic',
          },
        ],
      },
      antigravity: {
        catalogLoader: async () => [
          {
            id: 'ag-server',
            name: 'AG MCP Server',
            description: 'Antigravity ecosystem',
            trustLevel: 'official',
            publisher: 'antigravity',
          },
        ],
      },
    });

    const results = await registry.search({ query: 'server' });
    const ecosystems = new Set(results.map((r) => r.ecosystem));
    assert.ok(ecosystems.has('claude'));
    assert.ok(ecosystems.has('antigravity'));
  });
});
