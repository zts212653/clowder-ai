/**
 * F237 Phase 2 AC-P2-5: Dual-path validation test
 *
 * Tests the AssembleBridge (InvocationContext → AssemblerInput) and validates
 * that the pipeline produces meaningful output from bridge-constructed input.
 *
 * Registers test cats in the global CatRegistry so the bridge functions
 * can resolve config, mentions, roster, etc.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

describe('Dual-path validation: AssembleBridge + HookPipeline', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookPipeline.js')} */
  let pipelineMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js')} */
  let registryMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let resolversMod;
  /** @type {typeof import('../dist/domains/cats/services/context/prompt-template-loader.js')} */
  let templateMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/assemble-bridge.js')} */
  let bridgeMod;
  /** @type {import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let hookRegistry;
  /** @type {typeof import('@cat-cafe/shared').catRegistry} */
  let catReg;

  before(async () => {
    // Load modules
    const [pm, rm, rsm, tm, bm, shared] = await Promise.all([
      import('../dist/domains/prompt-hooks/HookPipeline.js'),
      import('../dist/domains/prompt-hooks/HookRegistry.js'),
      import('../dist/domains/prompt-hooks/resolvers/index.js'),
      import('../dist/domains/cats/services/context/prompt-template-loader.js'),
      import('../dist/domains/prompt-hooks/assemble-bridge.js'),
      import('@cat-cafe/shared'),
    ]);
    pipelineMod = pm;
    registryMod = rm;
    resolversMod = rsm;
    templateMod = tm;
    bridgeMod = bm;
    catReg = shared.catRegistry;

    // Register test cats so bridge functions can resolve configs
    catReg.reset();
    catReg.register('opus', {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见，喜欢深入分析问题',
      defaultModel: 'claude-opus-4-6',
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    });
    catReg.register('codex', {
      displayName: '缅因猫',
      nickname: '砚砚',
      name: 'Maine Coon',
      roleDescription: 'Review、找 bug、coding 落地',
      personality: '严谨',
      defaultModel: 'gpt-5.5',
      mentionPatterns: ['@codex'],
      restrictions: [],
      clientId: 'openai',
      breedId: 'maine-coon',
    });

    // Scan hook manifests
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const root = findMonorepoRoot();
    hookRegistry = new registryMod.HookRegistry(
      join(root, 'assets', 'prompt-hooks'),
      join(root, 'assets', 'prompt-templates'),
    );
    hookRegistry.scan();
  });

  after(() => {
    // Clean up test registry (in case other tests run after)
    catReg?.reset();
  });

  it('assembleForSession produces valid AssemblerInput', () => {
    const input = bridgeMod.assembleForSession('opus', { mcpAvailable: true });

    assert.equal(input.catId, 'opus');
    assert.equal(input.catConfig.displayName, '布偶猫');
    assert.equal(input.catConfig.nickname, '宪宪');
    assert.ok(input.runtimeModel, 'runtimeModel should be populated');
    assert.equal(input.providerLabel, 'Anthropic');
    assert.ok(input.coCreatorName, 'coCreatorName should be populated');
    assert.ok(input.governanceDigest.length > 0, 'governanceDigest should be populated');
    assert.equal(input.mode, 'independent');
    assert.equal(input.a2aEnabled, false);
    assert.equal(input.directMessage, null);
    // Callable mentions should include codex
    assert.ok(input.callableMentions.mentions.length > 0, 'Should have callable mentions');
  });

  it('session-init pipeline output from bridge input contains identity segments', () => {
    const input = bridgeMod.assembleForSession('opus', { mcpAvailable: true });
    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const result = pipeline.executeStage('session-init', input);
    const output = pipelineMod.HookPipeline.assemblePatches(result.patches);

    // S1: Identity
    assert.ok(output.includes('布偶猫'), 'Output should include displayName from S1');
    assert.ok(output.includes('宪宪'), 'Output should include nickname from S1');

    // S8: Co-creator reference
    assert.ok(output.includes(input.coCreatorName), 'Output should include co-creator name from S8');

    // S9: Governance digest (should be substantial)
    assert.ok(output.length > 500, `Session output should be >500 chars, got ${output.length}`);

    // S4: Collaboration format (callable mentions)
    assert.ok(output.includes('@codex'), 'Output should include callable mention from S4');

    // Event count: all 22 session-init hooks should produce events
    assert.equal(result.events.length, 22, `Expected 22 session events, got ${result.events.length}`);
  });

  it('per-turn pipeline output from bridge input contains expected segments', () => {
    const input = bridgeMod.assembleForSession('opus', { mcpAvailable: true });
    // Enrich with per-turn serial context
    const turnInput = {
      ...input,
      mode: /** @type {const} */ ('serial'),
      chainIndex: 1,
      chainTotal: 2,
      a2aEnabled: true,
      nativeL0Injected: false,
      directMessage: {
        fromCatId: 'codex',
        fromLabel: '缅因猫(codex)',
        fromModel: 'gpt-5.5',
        fromDisplayName: '缅因猫',
        isSameBreed: false,
      },
      teammates: [
        { id: 'codex', displayName: '缅因猫', nickname: '砚砚', name: 'Maine Coon', roleDescription: 'Review' },
      ],
      a2aBallCheckContent: '## A2A Ball Check\nBall ownership...',
      coCreatorFirstMention: '@lang',
    };

    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const result = pipeline.executeStage('per-turn', turnInput);
    const output = pipelineMod.HookPipeline.assemblePatches(result.patches);
    const firedIds = result.events.filter((e) => e.status === 'fired').map((e) => e.hookId);

    // D1: Identity anchor
    assert.ok(output.includes('布偶猫'), 'D1 identity anchor');
    assert.ok(firedIds.includes('D1'), 'D1 should fire');

    // D2: Direct message
    assert.ok(output.includes('缅因猫(codex)'), 'D2 direct message source');
    assert.ok(firedIds.includes('D2'), 'D2 should fire');

    // D6: Teammates
    assert.ok(output.includes('缅因猫/砚砚'), 'D6 teammate list');
    assert.ok(firedIds.includes('D6'), 'D6 should fire');

    // D7: Serial mode
    assert.ok(firedIds.includes('D7'), 'D7 should fire (serial)');

    // D8: A2A ball check
    assert.ok(firedIds.includes('D8'), 'D8 should fire (a2a serial)');

    // D15: Voice mode (always)
    assert.ok(firedIds.includes('D15'), 'D15 should fire');

    // Infrastructure hooks
    for (const id of ['R1', 'R2', 'N1']) {
      assert.ok(firedIds.includes(id), `${id} should fire`);
    }

    // 24 per-turn hooks → 24 events
    assert.equal(result.events.length, 24, `Expected 24 per-turn events, got ${result.events.length}`);
  });

  it('combined pipeline output is substantial (AC-P2-14)', () => {
    const input = bridgeMod.assembleForSession('opus', { mcpAvailable: true });
    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);

    const sessionResult = pipeline.executeStage('session-init', input);
    const turnResult = pipeline.executeStage('per-turn', { ...input, mode: 'serial', chainIndex: 1, chainTotal: 2 });

    const sessionOutput = pipelineMod.HookPipeline.assemblePatches(sessionResult.patches);
    const turnOutput = pipelineMod.HookPipeline.assemblePatches(turnResult.patches);

    assert.ok(sessionOutput.length > 1000, `Session should be >1000, got ${sessionOutput.length}`);
    assert.ok(turnOutput.length > 200, `Turn should be >200, got ${turnOutput.length}`);
    assert.ok(sessionOutput.length + turnOutput.length > 2000, 'Combined should be >2000');
  });

  it('all trace events have valid structure (AC-P2-7)', () => {
    const input = bridgeMod.assembleForSession('opus');
    const pipeline = new pipelineMod.HookPipeline(hookRegistry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);

    const sr = pipeline.executeStage('session-init', input);
    const tr = pipeline.executeStage('per-turn', { ...input, mode: 'serial', chainIndex: 1, chainTotal: 2 });
    const all = [...sr.events, ...tr.events];

    assert.ok(all.length >= 40, `Expected ≥40 events, got ${all.length}`);
    for (const event of all) {
      assert.ok(event.hookId, 'hookId required');
      assert.ok(event.stage, 'stage required');
      assert.ok(event.timestamp > 0, 'timestamp required');
      assert.ok(['fired', 'skipped', 'disabled'].includes(event.status), `valid status: ${event.status}`);
      if (event.status === 'fired') {
        assert.ok(/** @type {any} */ (event).contentHash, 'fired needs contentHash');
        assert.ok(typeof (/** @type {any} */ (event).tokenEstimate) === 'number', 'fired needs tokenEstimate');
      }
    }
  });
});
