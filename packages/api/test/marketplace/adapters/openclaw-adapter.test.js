// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('OpenClawMarketplaceAdapter', () => {
  let OpenClawMarketplaceAdapter;

  beforeEach(async () => {
    ({ OpenClawMarketplaceAdapter } = await import('../../../dist/marketplace/adapters/openclaw-adapter.js'));
  });

  it('has ecosystem = openclaw', () => {
    const adapter = new OpenClawMarketplaceAdapter({ catalogLoader: async () => [] });
    assert.strictEqual(adapter.ecosystem, 'openclaw');
  });

  it('disambiguates clawType — mcp_server vs bundle vs skill', async () => {
    const adapter = new OpenClawMarketplaceAdapter({
      catalogLoader: async () => [
        entry({ id: 'srv', clawType: 'mcp_server' }),
        entry({ id: 'bun', clawType: 'bundle', name: 'Bundle' }),
        entry({ id: 'skl', clawType: 'skill', name: 'Skill' }),
      ],
    });
    const results = await adapter.search({ query: '' });
    assert.strictEqual(results.find((r) => r.artifactId === 'srv').artifactKind, 'mcp_server');
    assert.strictEqual(results.find((r) => r.artifactId === 'bun').artifactKind, 'bundle');
    assert.strictEqual(results.find((r) => r.artifactId === 'skl').artifactKind, 'skill');
  });

  it('builds direct_mcp for mcp_server entries with command', async () => {
    const adapter = new OpenClawMarketplaceAdapter({
      catalogLoader: async () => [entry({ id: 'oc-mcp', clawType: 'mcp_server', command: 'uvx', args: ['mcp-srv'] })],
    });
    const plan = await adapter.buildInstallPlan('oc-mcp');
    assert.strictEqual(plan.mode, 'direct_mcp');
    assert.strictEqual(plan.mcpEntry.command, 'uvx');
  });

  it('builds delegated_cli for skill with cliInstallCommand', async () => {
    const adapter = new OpenClawMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'oc-skill',
          clawType: 'skill',
          cliInstallCommand: 'claw install oc-skill',
        }),
      ],
    });
    const plan = await adapter.buildInstallPlan('oc-skill');
    assert.strictEqual(plan.mode, 'delegated_cli');
    assert.ok(plan.delegatedCommand.includes('claw install'));
  });

  it('falls back to manual_file for bundle without CLI', async () => {
    const adapter = new OpenClawMarketplaceAdapter({
      catalogLoader: async () => [
        entry({
          id: 'oc-bun',
          clawType: 'bundle',
          sourceBundle: 'claude:filesystem',
        }),
      ],
    });
    const plan = await adapter.buildInstallPlan('oc-bun');
    assert.strictEqual(plan.mode, 'manual_file');
    assert.ok(plan.manualSteps.length > 0);
    assert.ok(plan.manualSteps.some((s) => s.includes('clawhub')));
  });

  it('throws for unknown artifactId', async () => {
    const adapter = new OpenClawMarketplaceAdapter({ catalogLoader: async () => [] });
    await assert.rejects(() => adapter.buildInstallPlan('nope'), /not found/);
  });
});

function entry(overrides = {}) {
  return {
    id: 'default',
    name: 'Default',
    description: 'Default desc',
    clawType: 'mcp_server',
    command: 'node',
    args: ['server.js'],
    trustLevel: 'verified',
    publisher: 'openclaw',
    ...overrides,
  };
}
