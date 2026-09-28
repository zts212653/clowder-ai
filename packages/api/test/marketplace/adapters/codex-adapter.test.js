// @ts-check
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('CodexMarketplaceAdapter', () => {
  let CodexMarketplaceAdapter;
  let deduplicateInFlightCapabilitySource;

  beforeEach(async () => {
    ({ CodexMarketplaceAdapter, deduplicateInFlightCapabilitySource } = await import(
      '../../../dist/marketplace/adapters/codex-adapter.js'
    ));
  });

  it('has ecosystem = codex', () => {
    const adapter = new CodexMarketplaceAdapter({ sourceLoader: async () => snapshot([]) });
    assert.strictEqual(adapter.ecosystem, 'codex');
  });

  it('projects provider MCP status without turning status into an install mutation', async () => {
    const adapter = new CodexMarketplaceAdapter({
      sourceLoader: async () =>
        snapshot([
          entry({
            id: 'mcp:tool',
            kind: 'mcp_server',
            lifecycle: { installed: true, enabled: true, authStatus: 'oAuth', toolCount: 2 },
          }),
        ]),
    });
    const results = await adapter.search({ query: '' });
    assert.equal(results[0].lifecycle.authStatus, 'oAuth');
    assert.equal(results[0].lifecycle.toolCount, 2);
    const plan = await adapter.buildInstallPlan('mcp:tool');
    assert.strictEqual(plan.mode, 'manual_ui');
    assert.equal(plan.mcpEntry, undefined);
    assert.equal(plan.delegatedCommand, undefined);
  });

  it('search result distinguishes skill, app, plugin, and mcp_server', async () => {
    const adapter = new CodexMarketplaceAdapter({
      sourceLoader: async () =>
        snapshot([
          entry({ id: 'mcp:a', kind: 'mcp_server' }),
          entry({ id: 'skill:a', kind: 'skill' }),
          entry({ id: 'app:a', kind: 'app' }),
          entry({ id: 'plugin:a', kind: 'plugin' }),
        ]),
    });
    const results = await adapter.search({ query: '' });
    assert.deepEqual(
      results.map((result) => result.artifactKind),
      ['mcp_server', 'skill', 'app', 'plugin'],
    );
  });

  it('throws for unknown artifactId', async () => {
    const adapter = new CodexMarketplaceAdapter({ sourceLoader: async () => snapshot([]) });
    await assert.rejects(() => adapter.buildInstallPlan('nope'), /not found/);
  });

  it('projects a fresh live provider snapshot without creating a second catalog', async () => {
    let loads = 0;
    const adapter = new CodexMarketplaceAdapter({
      sourceLoader: async () => {
        loads++;
        return {
          availability: 'live',
          providerVersion: '0.149.1',
          observedAt: '2026-09-02T17:00:00.000Z',
          issues: [],
          artifacts: [
            {
              id: 'app:calendar',
              kind: 'app',
              name: 'Calendar',
              description: 'Calendar connector',
              sourceLocator: 'codex:app/calendar',
              trustLevel: 'official',
              publisher: 'OpenAI',
              versionRef: '3.2.1',
              lifecycle: {
                installed: true,
                enabled: true,
                accessible: true,
                callable: true,
                maturity: 'experimental',
              },
            },
          ],
        };
      },
    });

    const first = await adapter.searchWithStatus({ query: 'calendar' });
    const second = await adapter.searchWithStatus({ query: 'calendar' });

    assert.equal(loads, 2);
    assert.equal(first.status.providerVersion, '0.149.1');
    assert.equal(first.results[0].artifactKind, 'app');
    assert.equal(first.results[0].providerSource.providerVersion, '0.149.1');
    assert.equal(first.results[0].lifecycle.callable, true);
    assert.equal(second.results.length, 1);
  });

  it('coalesces only overlapping provider reads and refreshes after settlement', async () => {
    let loads = 0;
    let resolveFirst;
    const load = deduplicateInFlightCapabilitySource(async () => {
      loads++;
      if (loads === 1) await new Promise((resolve) => (resolveFirst = resolve));
      return snapshot([]);
    });

    const first = load();
    const second = load();
    assert.equal(loads, 1);
    resolveFirst();
    await Promise.all([first, second]);
    await load();
    assert.equal(loads, 2, 'settled snapshots must not become a second provider cache');
  });

  it('sanitizes provider failures for install-plan callers', async () => {
    const adapter = new CodexMarketplaceAdapter({
      sourceLoader: async () => Promise.reject(new Error('secret provider path')),
    });
    await assert.rejects(() => adapter.buildInstallPlan('mcp:any'), /^Error: Codex provider source unavailable$/);
  });

  it('uses the existing manual lifecycle plan for provider-owned artifacts', async () => {
    const adapter = new CodexMarketplaceAdapter({
      sourceLoader: async () => ({
        availability: 'live',
        providerVersion: '0.149.1',
        observedAt: '2026-09-02T17:00:00.000Z',
        issues: [],
        artifacts: [
          {
            id: 'plugin:provider-kit',
            kind: 'plugin',
            name: 'Provider Kit',
            description: 'Provider utilities',
            sourceLocator: 'codex:plugin/provider-kit',
            trustLevel: 'official',
            publisher: 'OpenAI',
            lifecycle: { installed: false, enabled: false, authPolicy: 'ON_USE' },
          },
        ],
      }),
    });

    const plan = await adapter.buildInstallPlan('plugin:provider-kit');
    assert.equal(plan.mode, 'manual_ui');
    assert.ok(plan.manualSteps.some((step) => step.includes('现有')));
    assert.equal(plan.metadata.providerVersion, '0.149.1');
  });
});

function entry(overrides = {}) {
  return {
    id: 'mcp:default',
    kind: 'mcp_server',
    name: 'Default',
    description: 'Default desc',
    sourceLocator: 'codex:mcp/default',
    trustLevel: 'verified',
    publisher: 'Codex provider',
    ...overrides,
  };
}

function snapshot(artifacts) {
  return {
    availability: 'live',
    providerVersion: '0.149.1',
    observedAt: '2026-09-02T17:00:00.000Z',
    issues: [],
    artifacts,
  };
}
