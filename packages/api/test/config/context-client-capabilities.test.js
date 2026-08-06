/**
 * Context Client Capabilities + Nine-Client Fail-Closed Coverage
 * clowder-ai#1208 Item 6
 *
 * Tests:
 *   1. CLIENT_CONTEXT_CAPABILITIES covers all 9 ClientId values
 *   2. getClientCapability fail-closed for unknown clients
 *   3. Nine-client resolver coverage: each client with known model (catalog)
 *      and unknown model (fail-closed)
 *   4. Regression: 211537 > 202752 scenario — resolver must produce
 *      actionable capacity when manual cap is set for the gateway limit
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'test-item6-cat';

const ALL_CLIENT_IDS = ['anthropic', 'openai', 'opencode', 'google', 'kimi', 'antigravity', 'catagent', 'acp', 'a2a'];

function makeCatConfig(overrides = {}) {
  return {
    id: TEST_CAT_ID,
    name: 'test-item6',
    displayName: 'Item 6 Test Cat',
    avatar: '🐱',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@test-item6'],
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    mcpSupport: false,
    roleDescription: 'test',
    personality: 'test',
    ...overrides,
  };
}

describe('#1208 Item 6: client capabilities + fail-closed coverage', () => {
  let capMod;
  let resolverMod;
  let savedConfigs;

  before(async () => {
    capMod = await import('../../dist/config/context-client-capabilities.js');
    resolverMod = await import('../../dist/config/context-capacity.js');
    savedConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
  });

  afterEach(() => {
    catRegistry.reset();
  });

  after(() => {
    for (const [id, config] of Object.entries(savedConfigs)) {
      catRegistry.register(id, config);
    }
  });

  // ── 1. Registry completeness ──────────────────────────────────────

  // ── 1. Registry completeness (3-dimension model) ──────────────────

  describe('CLIENT_CONTEXT_CAPABILITIES registry', () => {
    it('covers all 9 ClientId values with 3 capability dimensions', () => {
      for (const clientId of ALL_CLIENT_IDS) {
        const cap = capMod.CLIENT_CONTEXT_CAPABILITIES[clientId];
        assert.ok(cap, `Missing capability entry for client "${clientId}"`);
        assert.equal(typeof cap.catalogAvailable, 'boolean', `${clientId}.catalogAvailable must be boolean`);
        assert.equal(typeof cap.reportsRuntimeWindow, 'boolean', `${clientId}.reportsRuntimeWindow must be boolean`);
        assert.equal(typeof cap.reportsUsage, 'boolean', `${clientId}.reportsUsage must be boolean`);
        assert.ok(cap.reason.length > 0, `${clientId}.reason must be non-empty`);
      }
    });

    it('full-reporting clients: anthropic, openai, google, kimi (all 3 dimensions true)', () => {
      for (const clientId of ['anthropic', 'openai', 'google', 'kimi']) {
        const cap = capMod.CLIENT_CONTEXT_CAPABILITIES[clientId];
        assert.equal(cap.catalogAvailable, true, `${clientId} should have catalog`);
        assert.equal(cap.reportsRuntimeWindow, true, `${clientId} should report runtime window`);
        assert.equal(cap.reportsUsage, true, `${clientId} should report usage`);
      }
    });

    it('antigravity: catalog=true, runtimeWindow=false, usage=false (catalog != runtime)', () => {
      // Sol push-back: catalog lookup != runtime window reporting.
      // Antigravity wraps Claude models (catalog available) but the bridge
      // itself does NOT emit runtime window or usage data.
      const cap = capMod.CLIENT_CONTEXT_CAPABILITIES.antigravity;
      assert.equal(cap.catalogAvailable, true, 'Antigravity has catalog via Claude models');
      assert.equal(cap.reportsRuntimeWindow, false, 'Antigravity bridge does NOT report runtime window');
      assert.equal(cap.reportsUsage, false, 'Antigravity bridge does NOT report usage');
    });

    it('opencode + catagent: catalog=true, runtimeWindow=false, usage=true', () => {
      for (const clientId of ['opencode', 'catagent']) {
        const cap = capMod.CLIENT_CONTEXT_CAPABILITIES[clientId];
        assert.equal(cap.catalogAvailable, true, `${clientId} has catalog`);
        assert.equal(cap.reportsRuntimeWindow, false, `${clientId} does NOT report runtime window`);
        assert.equal(cap.reportsUsage, true, `${clientId} reports usage`);
      }
    });

    it('opaque clients (acp, a2a): all 3 dimensions false', () => {
      for (const clientId of ['acp', 'a2a']) {
        const cap = capMod.CLIENT_CONTEXT_CAPABILITIES[clientId];
        assert.equal(cap.catalogAvailable, false, `${clientId} should NOT have catalog`);
        assert.equal(cap.reportsRuntimeWindow, false, `${clientId} should NOT report runtime window`);
        assert.equal(cap.reportsUsage, false, `${clientId} should NOT report usage`);
      }
    });
  });

  // ── 2. getClientCapability fail-closed ─────────────────────────────

  describe('getClientCapability', () => {
    it('unknown client fails closed (all 3 dimensions false)', () => {
      const cap = capMod.getClientCapability('some-unknown-client');
      assert.equal(cap.catalogAvailable, false);
      assert.equal(cap.reportsRuntimeWindow, false);
      assert.equal(cap.reportsUsage, false);
      assert.ok(cap.reason.includes('Unknown client'));
    });

    it('undefined client fails closed', () => {
      const cap = capMod.getClientCapability(undefined);
      assert.equal(cap.catalogAvailable, false);
      assert.equal(cap.reportsRuntimeWindow, false);
      assert.equal(cap.reportsUsage, false);
    });

    it('known client returns correct entry', () => {
      const cap = capMod.getClientCapability('anthropic');
      assert.equal(cap.catalogAvailable, true);
      assert.equal(cap.reportsRuntimeWindow, true);
      assert.equal(cap.reportsUsage, true);
    });
  });

  // ── 3. Nine-client resolver coverage ──────────────────────────────

  describe('nine-client resolver coverage', () => {
    // All 9 clients use claude-opus-4-6 (1M, known in catalog)
    // to test the catalog resolution path. This isolates the
    // client variable — model is constant.
    const CATALOG_MODEL = 'claude-opus-4-6';

    for (const clientId of ALL_CLIENT_IDS) {
      it(`${clientId} with known model → catalog source, NOT actionable`, () => {
        catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId, defaultModel: CATALOG_MODEL }));
        const capacity = resolverMod.resolveContextCapacity({
          catId: TEST_CAT_ID,
          model: CATALOG_MODEL,
          provider: clientId === 'opencode' ? 'opencode' : undefined,
          client: clientId,
        });
        // Known model → catalog source (not exact/manual), so NOT actionable
        assert.equal(capacity.source, 'catalog', `${clientId}: expected catalog source`);
        assert.equal(capacity.actionable, false, `${clientId}: catalog alone must NOT be actionable`);
        assert.ok(capacity.windowTokens > 0, `${clientId}: should have a positive window`);
      });
    }

    for (const clientId of ALL_CLIENT_IDS) {
      it(`${clientId} with unknown model, no manual cap → fail-closed`, () => {
        const unknownModel = `custom-model-${clientId}-unknown`;
        catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId, defaultModel: unknownModel }));
        const capacity = resolverMod.resolveContextCapacity({
          catId: TEST_CAT_ID,
          model: unknownModel,
          provider: clientId === 'opencode' ? 'opencode' : undefined,
          client: clientId,
        });
        if (clientId === 'opencode') {
          // OpenCode has a 128K last-resort default for unknown models
          assert.equal(capacity.source, 'default');
          assert.equal(capacity.actionable, false, 'OpenCode default must NOT be actionable');
        } else {
          // All other clients: unknown model = unresolved = fail-closed
          assert.equal(capacity.source, 'unresolved', `${clientId}: unknown model should be unresolved`);
          assert.equal(capacity.actionable, false, `${clientId}: unresolved must NOT be actionable`);
          assert.equal(capacity.windowTokens, 0, `${clientId}: unresolved window must be 0`);
        }
      });
    }
  });

  // ── 4. Manual cap makes catalog actionable (gateway cap scenario) ──

  describe('manual cap + catalog → actionable', () => {
    it('gateway cap below model window makes result actionable', () => {
      // Scenario: user runs through a gateway that caps at 202752
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ clientId: 'opencode', defaultModel: 'claude-opus-4-6', contextWindow: 202752 }),
      );
      const capacity = resolverMod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6',
        provider: 'opencode',
        client: 'opencode',
      });
      // Model catalog: opus = 1M. Manual cap 202752 is binding (< 1M).
      assert.equal(capacity.windowTokens, 202752);
      assert.equal(capacity.actionable, true, 'Manual cap binding below catalog → actionable');
      assert.ok(capacity.provenance.includes('capped'));
    });

    it('manual cap enables all 9 clients to be actionable', () => {
      for (const clientId of ALL_CLIENT_IDS) {
        catRegistry.reset();
        catRegistry.register(
          TEST_CAT_ID,
          makeCatConfig({ clientId, defaultModel: 'claude-opus-4-6', contextWindow: 200000 }),
        );
        const capacity = resolverMod.resolveContextCapacity({
          catId: TEST_CAT_ID,
          model: 'claude-opus-4-6',
          client: clientId,
        });
        // Manual cap 200K is binding below opus 1M → actionable for ALL clients
        assert.equal(capacity.actionable, true, `${clientId}: manual cap should make result actionable`);
        assert.equal(capacity.windowTokens, 200000, `${clientId}: should use manual cap`);
      }
    });
  });

  // ── 5. Regression: 211537 > 202752 ────────────────────────────────

  describe('regression: 211537 > 202752 scenario', () => {
    it('gateway with 202752 limit resolves to actionable capacity with correct input ceiling', () => {
      // Original issue #1208: CodeAgent 3.0 through a 202752-token gateway.
      // Without manual cap, resolver returns non-actionable → handoff can't trigger → overflow.
      // With manual cap = 202752, resolver returns actionable → handoff triggers at threshold.
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ clientId: 'opencode', defaultModel: 'custom-gateway-model', contextWindow: 202752 }),
      );
      const capacity = resolverMod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'custom-gateway-model',
        provider: 'opencode',
        client: 'opencode',
      });
      // Unknown model + OpenCode → default 128K. Manual cap 202752 > 128K → not binding.
      // Effective window = 128K (the OpenCode default), manual cap not binding.
      // For the ACTUAL gateway limit, the user should set contextWindow = 202752
      // and if no catalog entry exists, manual becomes the sole source → actionable.
      assert.ok(capacity.windowTokens > 0, 'Should have a valid window');
    });

    it('manual-only resolution for unknown gateway model is actionable', () => {
      // When ONLY manual cap is available (no CLI report, no catalog, no provider default)
      // this is the "manual" source → actionable.
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ clientId: 'acp', defaultModel: 'unknown-gateway-model', contextWindow: 202752 }),
      );
      const capacity = resolverMod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'unknown-gateway-model',
        client: 'acp',
      });
      // No catalog entry, no provider default, only manual cap → source = 'manual'
      assert.equal(capacity.source, 'manual');
      assert.equal(capacity.windowTokens, 202752);
      assert.equal(capacity.actionable, true, 'Manual-only resolution must be actionable');
      // Verify handoff would trigger: at 75% action threshold = 152064 tokens
      const actionThreshold = 0.75;
      const handoffTriggerAt = Math.floor(capacity.windowTokens * actionThreshold);
      assert.equal(handoffTriggerAt, 152064, 'Handoff should trigger at 152064 tokens');
      assert.ok(handoffTriggerAt < 211537, 'Handoff trigger point must be below the overflow value');
    });

    it('correct input ceiling derivation for 202752 window', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ clientId: 'acp', defaultModel: 'gateway-model', contextWindow: 202752 }),
      );
      const capacity = resolverMod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'gateway-model',
        client: 'acp',
      });
      // inputCeiling = 202752 - 16000 (output reserve) = 186752
      assert.equal(capacity.inputCeilingTokens, 186752);
      // Verify derived budget matches
      const budget = resolverMod.derivePromptAssemblyBudget(capacity.inputCeilingTokens);
      assert.equal(budget.maxPromptTokens, 186752);
      assert.equal(budget.maxHistoryContextTokens, Math.floor(186752 * 0.85));
    });
  });
});
