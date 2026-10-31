import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AdapterRegistry } from '../dist/marketplace/adapter-registry.js';

describe('F146-D P1-2: AdapterRegistry injects ecosystem into install plan', () => {
  it('adds ecosystem to mcpEntry in direct_mcp plan', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      ecosystem: 'claude',
      search: async () => [],
      buildInstallPlan: async () => ({
        mode: 'direct_mcp',
        mcpEntry: { id: 'test-mcp', command: 'npx', args: ['-y', 'test-mcp'] },
      }),
    });

    const plan = await registry.buildInstallPlan('claude', 'test-mcp');
    assert.equal(plan.mcpEntry.ecosystem, 'claude');
  });

  it('does not overwrite existing ecosystem in mcpEntry', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      ecosystem: 'codex',
      search: async () => [],
      buildInstallPlan: async () => ({
        mode: 'direct_mcp',
        mcpEntry: { id: 'test-mcp', command: 'npx', ecosystem: 'openclaw' },
      }),
    });

    const plan = await registry.buildInstallPlan('codex', 'test-mcp');
    assert.equal(plan.mcpEntry.ecosystem, 'openclaw');
  });

  it('leaves non-direct_mcp plans unchanged', async () => {
    const registry = new AdapterRegistry();
    registry.register({
      ecosystem: 'antigravity',
      search: async () => [],
      buildInstallPlan: async () => ({
        mode: 'delegated',
        delegatedCommand: 'ag install test',
      }),
    });

    const plan = await registry.buildInstallPlan('antigravity', 'test');
    assert.equal(plan.mode, 'delegated');
    assert.equal(plan.mcpEntry, undefined);
  });
});
