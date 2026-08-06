/**
 * context-capacity resolver tests
 * clowder-ai#1208: verify the unified context capacity resolution chain.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'test-cap-cat';

/** Minimal CatConfig for testing contextWindow resolution. */
function makeCatConfig(overrides = {}) {
  return {
    id: TEST_CAT_ID,
    name: 'test-cap',
    displayName: 'Test Cap Cat',
    avatar: '🐱',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: ['@test-cap'],
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-20250918',
    mcpSupport: false,
    roleDescription: 'test',
    personality: 'test',
    ...overrides,
  };
}

describe('context-capacity resolver', () => {
  let mod;
  let savedConfigs;

  before(async () => {
    mod = await import('../../dist/config/context-capacity.js');
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

  describe('getMemberWindowCap', () => {
    it('returns undefined when no cat registered', () => {
      assert.equal(mod.getMemberWindowCap('nonexistent'), undefined);
    });

    it('returns undefined when contextWindow not set (Auto mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), undefined);
    });

    it('returns the configured cap when contextWindow is set (Manual mode)', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 500_000 }));
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 500_000);
    });

    it('compat-reads legacy cli.contextWindow when top-level absent', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 } }),
      );
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 256_000);
    });

    it('top-level contextWindow takes precedence over cli.contextWindow', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          contextWindow: 400_000,
          cli: { command: 'codex', outputFormat: 'json', contextWindow: 256_000 },
        }),
      );
      assert.equal(mod.getMemberWindowCap(TEST_CAT_ID), 400_000);
    });
  });

  describe('getMemberOutputReserve', () => {
    it('returns a positive number (internal derivation)', () => {
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(typeof reserve, 'number');
      assert.ok(reserve > 0, 'output reserve must be positive');
    });
  });

  // ─── Binding Key & Fingerprint ───────────────────────────────────

  describe('computeBindingFingerprint', () => {
    it('produces a deterministic string from binding key', () => {
      const key = { member: 'opus', client: 'anthropic', model: 'claude-opus-4-6' };
      const fp1 = mod.computeBindingFingerprint(key);
      const fp2 = mod.computeBindingFingerprint(key);
      assert.equal(fp1, fp2);
      assert.equal(typeof fp1, 'string');
      assert.ok(fp1.length > 0);
    });

    it('different models produce different fingerprints', () => {
      const fp1 = mod.computeBindingFingerprint({ member: 'opus', client: 'anthropic', model: 'claude-opus-4-6' });
      const fp2 = mod.computeBindingFingerprint({ member: 'opus', client: 'anthropic', model: 'claude-sonnet-4-6' });
      assert.notEqual(fp1, fp2);
    });

    it('includes optional fields when present', () => {
      const without = mod.computeBindingFingerprint({ member: 'x', client: 'y', model: 'z' });
      const withCarrier = mod.computeBindingFingerprint({ member: 'x', client: 'y', model: 'z', carrier: 'bg' });
      assert.notEqual(without, withCarrier);
    });
  });

  // ─── resolveContextCapacity ──────────────────────────────────────

  describe('resolveContextCapacity', () => {
    it('returns unresolved when no data available', () => {
      const result = mod.resolveContextCapacity({ catId: 'unknown-cat' });
      assert.equal(result.source, 'unresolved');
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 0);
      assert.equal(result.confidence, 0);
      assert.ok(result.bindingKey, 'should have binding key');
      assert.ok(result.fingerprint, 'should have fingerprint');
      assert.ok(result.observedAt > 0, 'should have observedAt');
    });

    it('uses CLI-reported window as exact source', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig());
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 1_000_000,
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'exact');
      assert.equal(result.actionable, true);
      assert.equal(result.confidence, 1.0);
      assert.ok(result.windowTokens > 0);
    });

    it('falls back to model catalog — NOT actionable without manual cap', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ defaultModel: 'claude-opus-4-6' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6',
      });
      assert.equal(result.source, 'catalog');
      // catalog alone is NOT actionable — must not masquerade as exact
      assert.equal(result.actionable, false);
      assert.equal(result.confidence, 0.7);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with known model uses catalog, not 128K default', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'claude-opus-4-6', // 1M in catalog
      });
      assert.equal(result.source, 'catalog');
      // catalog without manual cap = NOT actionable
      assert.equal(result.actionable, false);
      assert.equal(result.windowTokens, 1_000_000);
    });

    it('OpenCode with unknown model falls back to 128K default — NOT actionable', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'custom-vendor/mystery-model-v3', // NOT in catalog
      });
      assert.equal(result.source, 'default');
      // default alone is NOT actionable
      assert.equal(result.actionable, false);
      assert.equal(result.confidence, 0.3);
      assert.equal(result.windowTokens, 128_000);
    });

    it('OpenCode with known model but manual cap → actionable (cap is binding)', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({
          clientId: 'opencode',
          contextWindow: 128_000,
        }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        provider: 'opencode',
        model: 'claude-opus-4-6', // 1M in catalog
      });
      // Manual cap (128K) limits the catalog value (1M) → actionable
      assert.equal(result.actionable, true);
      assert.equal(result.windowTokens, 128_000);
      assert.ok(result.provenance.includes('capped'), 'provenance should mention capping');
    });

    it('OpenCode with CLI-reported window uses exact value', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 200_000,
        provider: 'opencode',
        model: 'claude-opus-4-20250918',
      });
      assert.equal(result.source, 'exact');
      assert.equal(result.actionable, true);
      assert.ok(result.windowTokens >= 200_000);
    });

    it('manual cap limits discovered window', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 1_000_000,
        model: 'claude-opus-4-20250918',
      });
      assert.ok(result.windowTokens <= 200_000, `window ${result.windowTokens} should be <= 200K cap`);
      assert.equal(result.actionable, true);
      assert.ok(result.provenance.includes('capped'), 'provenance should mention capping');
    });

    it('manual cap is sole source when no discovery available', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 300_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
      });
      assert.equal(result.source, 'manual');
      assert.equal(result.windowTokens, 300_000);
      assert.equal(result.actionable, true);
      assert.equal(result.confidence, 0.95);
    });

    it('legacy cli.contextWindow works as manual cap', () => {
      catRegistry.register(
        TEST_CAT_ID,
        makeCatConfig({ cli: { command: 'codex', outputFormat: 'json', contextWindow: 150_000 } }),
      );
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        reportedWindowSize: 500_000,
        model: 'some-model',
      });
      assert.ok(result.windowTokens <= 150_000, `legacy cap should limit to 150K, got ${result.windowTokens}`);
    });

    it('inputCeilingTokens is window minus output reserve', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const result = mod.resolveContextCapacity({ catId: TEST_CAT_ID });
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(result.inputCeilingTokens, result.windowTokens - reserve);
    });

    it('manual cap not binding does NOT make catalog actionable', () => {
      // User sets cap at 2M but catalog discovers 1M → cap is NOT binding
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 2_000_000 }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6', // 1M in catalog
      });
      assert.equal(result.source, 'catalog');
      assert.equal(result.windowTokens, 1_000_000);
      // Cap is not binding (2M > 1M) → catalog alone → NOT actionable
      assert.equal(result.actionable, false);
      assert.ok(result.provenance.includes('not binding'));
    });

    // ─── Binding key in result ─────────────────────────────────────

    it('includes binding key derived from options and config', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'opencode', accountRef: 'sponsor1' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'claude-opus-4-6',
        provider: 'opencode',
      });
      assert.equal(result.bindingKey.member, TEST_CAT_ID);
      assert.equal(result.bindingKey.client, 'opencode');
      assert.equal(result.bindingKey.account, 'sponsor1');
      assert.equal(result.bindingKey.model, 'claude-opus-4-6');
    });

    it('explicit client/account options override config', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ clientId: 'anthropic', accountRef: 'default' }));
      const result = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        client: 'opencode',
        account: 'sponsor2',
        model: 'claude-opus-4-6',
      });
      assert.equal(result.bindingKey.client, 'opencode');
      assert.equal(result.bindingKey.account, 'sponsor2');
    });
  });

  // ─── Session Pin ─────────────────────────────────────────────────

  describe('applySessionPin', () => {
    function makeResolved(windowTokens, fingerprint = 'test|anthropic|||claude-opus-4-6|') {
      const outputReserve = 16_000;
      return {
        windowTokens,
        inputCeilingTokens: windowTokens - outputReserve,
        source: 'exact',
        confidence: 1.0,
        provenance: 'test',
        actionable: true,
        bindingKey: { member: 'test', client: 'anthropic', model: 'claude-opus-4-6' },
        fingerprint,
        observedAt: Date.now(),
      };
    }

    function makePin(windowTokens, fingerprint = 'test|anthropic|||claude-opus-4-6|') {
      const outputReserve = 16_000;
      return {
        windowTokens,
        inputCeilingTokens: windowTokens - outputReserve,
        fingerprint,
        pinnedAt: Date.now(),
      };
    }

    it('no existing pin → pins to resolved value with inputCeiling', () => {
      const resolved = makeResolved(1_000_000);
      const { effective, pin } = mod.applySessionPin(resolved, undefined);
      assert.equal(effective.windowTokens, 1_000_000);
      assert.equal(pin.windowTokens, 1_000_000);
      assert.equal(pin.inputCeilingTokens, 984_000);
      assert.equal(pin.fingerprint, resolved.fingerprint);
    });

    it('same binding, smaller value → shrinks (safety)', () => {
      const pin = makePin(1_000_000);
      const resolved = makeResolved(800_000);
      const result = mod.applySessionPin(resolved, pin);
      assert.equal(result.effective.windowTokens, 800_000);
      assert.equal(result.pin.windowTokens, 800_000);
      assert.equal(result.pin.inputCeilingTokens, 784_000);
    });

    it('same binding, larger value → keeps pinned (shrink-no-expand)', () => {
      const pin = makePin(500_000);
      const resolved = makeResolved(1_000_000);
      const result = mod.applySessionPin(resolved, pin);
      assert.equal(result.effective.windowTokens, 500_000);
      assert.equal(result.effective.inputCeilingTokens, 484_000);
      assert.ok(result.effective.provenance.includes('session-pinned'));
    });

    it('different binding fingerprint → new pin', () => {
      const pin = makePin(500_000);
      const resolved = makeResolved(1_000_000, 'test|anthropic|||claude-sonnet-4-6|');
      const result = mod.applySessionPin(resolved, pin);
      // New binding → use resolved, new pin
      assert.equal(result.effective.windowTokens, 1_000_000);
      assert.equal(result.pin.fingerprint, 'test|anthropic|||claude-sonnet-4-6|');
    });

    it('same binding, equal value → keeps current', () => {
      const pin = makePin(500_000);
      const resolved = makeResolved(500_000);
      const result = mod.applySessionPin(resolved, pin);
      assert.equal(result.effective.windowTokens, 500_000);
    });
  });

  // ─── CONFIDENCE_SCORES ──────────────────────────────────────────

  describe('CONFIDENCE_SCORES', () => {
    it('has monotonically decreasing scores', () => {
      const { CONFIDENCE_SCORES: scores } = mod;
      assert.ok(scores.exact > scores.manual, 'exact > manual');
      assert.ok(scores.manual > scores.catalog, 'manual > catalog');
      assert.ok(scores.catalog > scores.default, 'catalog > default');
      assert.ok(scores.default > scores.unresolved, 'default > unresolved');
    });
  });

  // ─── derivePromptAssemblyBudget ──────────────────────────────────

  describe('derivePromptAssemblyBudget', () => {
    it('produces sensible limits from input ceiling', () => {
      const budget = mod.derivePromptAssemblyBudget(100_000);
      assert.equal(budget.maxPromptTokens, 100_000);
      assert.ok(budget.maxHistoryContextTokens < 100_000, 'history < total');
      assert.ok(budget.maxHistoryContextTokens > 50_000, 'history reasonable');
      assert.ok(budget.maxMessages >= 50, 'at least 50 messages');
      assert.ok(budget.maxContentLengthPerMsg > 0, 'positive content limit');
    });

    it('scales message count with ceiling', () => {
      const small = mod.derivePromptAssemblyBudget(50_000);
      const large = mod.derivePromptAssemblyBudget(500_000);
      assert.ok(large.maxMessages >= small.maxMessages, 'larger ceiling = more messages');
    });
  });

  // ─── #1208 Denominator Fix: fillRatio uses inputCeiling ─────────

  describe('#1208 denominator fix', () => {
    it('fillRatio denominator is inputCeiling (window - output reserve), not raw window', () => {
      // Scenario: 200K manual cap → window=200K, inputCeiling=184K (200K - 16K reserve).
      // usedTokens=160K → fillRatio should be 160K/184K ≈ 0.8696, NOT 160K/200K = 0.8.
      // This matters: at 0.85 action threshold, the old wrong denominator (0.8) says "safe"
      // while the correct denominator (0.87) says "action" → the fix prevents overflow.
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 200_000 }));
      const capacity = mod.resolveContextCapacity({ catId: TEST_CAT_ID });
      const outputReserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(capacity.windowTokens, 200_000);
      assert.equal(capacity.inputCeilingTokens, 200_000 - outputReserve);
      // Verify the correct denominator for fillRatio computation
      const usedTokens = 160_000;
      const correctFillRatio = usedTokens / capacity.inputCeilingTokens;
      const wrongFillRatio = usedTokens / capacity.windowTokens;
      // Correct: 160000/184000 = 0.8696 (above typical 0.85 action threshold)
      assert.ok(
        correctFillRatio > 0.85,
        `correct fillRatio ${correctFillRatio.toFixed(4)} should exceed 0.85 action threshold`,
      );
      // Wrong: 160000/200000 = 0.8 (below 0.85 action threshold → overflow!)
      assert.ok(wrongFillRatio < 0.85, `wrong fillRatio ${wrongFillRatio.toFixed(4)} would miss the threshold`);
    });

    it('inputCeilingTokens equals windowTokens minus output reserve', () => {
      catRegistry.register(TEST_CAT_ID, makeCatConfig({ contextWindow: 202_752 }));
      const capacity = mod.resolveContextCapacity({
        catId: TEST_CAT_ID,
        model: 'unknown-gateway-model',
        client: 'acp',
      });
      const reserve = mod.getMemberOutputReserve(TEST_CAT_ID);
      assert.equal(capacity.inputCeilingTokens, 202_752 - reserve);
      // The input ceiling is the correct denominator for lifecycle decisions
      assert.ok(
        capacity.inputCeilingTokens < capacity.windowTokens,
        'inputCeiling must be strictly less than window (output reserve > 0)',
      );
    });

    it('carrier in binding key differentiates fingerprints', () => {
      const fpNone = mod.computeBindingFingerprint({ member: 'x', client: 'openai', model: 'm' });
      const fpExec = mod.computeBindingFingerprint({ member: 'x', client: 'openai', model: 'm', carrier: 'exec_json' });
      const fpApp = mod.computeBindingFingerprint({ member: 'x', client: 'openai', model: 'm', carrier: 'app_server' });
      assert.notEqual(fpNone, fpExec, 'no carrier vs exec_json should differ');
      assert.notEqual(fpExec, fpApp, 'exec_json vs app_server should differ');
      assert.notEqual(fpNone, fpApp, 'no carrier vs app_server should differ');
    });
  });
});
