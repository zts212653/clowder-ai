// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('AntigravityMarketplaceAdapter', () => {
  let AntigravityMarketplaceAdapter;

  beforeEach(async () => {
    ({ AntigravityMarketplaceAdapter } = await import('../../../dist/marketplace/adapters/antigravity-adapter.js'));
  });

  it('has ecosystem = antigravity', () => {
    const adapter = new AntigravityMarketplaceAdapter({ catalogLoader: async () => [] });
    assert.strictEqual(adapter.ecosystem, 'antigravity');
  });

  it('always returns manual_ui for generic entries', async () => {
    const adapter = new AntigravityMarketplaceAdapter({
      catalogLoader: async () => [entry({ id: 'ag-ext' })],
    });
    const plan = await adapter.buildInstallPlan('ag-ext');
    assert.strictEqual(plan.mode, 'manual_ui');
    assert.ok(plan.manualSteps);
    assert.ok(plan.manualSteps.length > 0);
    assert.ok(plan.manualSteps.some((s) => s.includes('Antigravity')));
  });

  it('resolver entries get manual_file with resolver hint (AC-B5 pencil consistency)', async () => {
    const adapter = new AntigravityMarketplaceAdapter({
      catalogLoader: async () => [entry({ id: 'pencil', resolver: 'pencil', name: 'Pencil' })],
    });
    const plan = await adapter.buildInstallPlan('pencil');
    assert.strictEqual(plan.mode, 'manual_file');
    assert.ok(plan.manualSteps.some((s) => s.includes('resolver')));
    assert.ok(plan.manualSteps.some((s) => s.includes('pencil')));
  });

  it('search returns all catalog entries', async () => {
    const adapter = new AntigravityMarketplaceAdapter({
      catalogLoader: async () => [entry({ id: 'ag-1' }), entry({ id: 'ag-2', name: 'Second' })],
    });
    const results = await adapter.search({ query: '' });
    assert.strictEqual(results.length, 2);
    for (const r of results) {
      assert.strictEqual(r.ecosystem, 'antigravity');
    }
  });

  it('throws for unknown artifactId', async () => {
    const adapter = new AntigravityMarketplaceAdapter({ catalogLoader: async () => [] });
    await assert.rejects(() => adapter.buildInstallPlan('nope'), /not found/);
  });
});

function entry(overrides = {}) {
  return {
    id: 'default',
    name: 'Default Extension',
    description: 'An Antigravity extension',
    trustLevel: 'official',
    publisher: 'antigravity',
    ...overrides,
  };
}
