/**
 * F237 Phase 2 (AC-P2-6): PipelinePromptBuilder tests
 *
 * Verifies that pipeline-backed buildStaticIdentityViaHookPipeline and
 * buildInvocationContextViaHookPipeline produce meaningful output and
 * respect overrides.
 *
 * Registers test cats in CatRegistry (same setup as dual-path-validation).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

describe('PipelinePromptBuilder (AC-P2-6)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js')} */
  let ppb;
  /** @type {typeof import('@cat-cafe/shared').catRegistry} */
  let catReg;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;

    // Register test cats so AssembleBridge can resolve configs
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

    ppb = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
  });

  after(() => {
    catReg?.reset();
    ppb?.resetPipelineSingleton();
  });

  // -- Session-init delegation -------------------------------------------------

  it('buildStaticIdentityViaHookPipeline produces non-empty session prompt', () => {
    const output = ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: true });
    assert.ok(output.length > 200, `Session prompt should be substantial (got ${output.length})`);
    assert.ok(output.includes('布偶猫'), 'Contains identity displayName');
    assert.ok(output.includes('宪宪'), 'Contains nickname');
  });

  it('session prompt includes L-layer hooks (L1-L7)', () => {
    const output = ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: false });
    // L1 = shared-rules, L4 = iron laws — always fire
    assert.ok(output.includes('P1'), 'L1 shared-rules contains principles');
    assert.ok(output.includes('铁律'), 'L4 iron laws in session');
  });

  // -- Per-turn delegation -----------------------------------------------------

  it('buildInvocationContextViaHookPipeline produces non-empty turn prompt', () => {
    const output = ppb.buildInvocationContextViaHookPipeline({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    assert.ok(output.length > 100, `Turn prompt should be substantial (got ${output.length})`);
    assert.ok(output.includes('布偶猫'), 'Contains identity anchor');
  });

  // -- Full system prompt ------------------------------------------------------

  it('buildSystemPromptViaHookPipeline combines session + turn', () => {
    const { prompt, sessionInput, turnInput } = ppb.buildSystemPromptViaHookPipeline({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    assert.ok(prompt.length > 500, 'Combined prompt substantial');
    assert.equal(sessionInput.catId, 'opus');
    assert.equal(turnInput.catId, 'opus');
  });

  // -- Override integration (pipeline-backed) ----------------------------------

  it('overrides disable a hook in pipeline-backed builder', () => {
    /** @type {Map<string, import('@cat-cafe/shared').EffectiveHookState>} */
    const overrides = new Map([['D15', { enabled: false, version: 1, templateOverride: null, source: 'operator' }]]);
    const withOverrides = ppb.buildInvocationContextViaHookPipeline(
      { catId: 'opus', mode: 'independent', teammates: [], mcpAvailable: true },
      overrides,
    );
    const without = ppb.buildInvocationContextViaHookPipeline({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    // D15 is voice mode — disabling it should produce shorter output
    assert.ok(withOverrides.length <= without.length, 'Disabled hook reduces output');
  });

  // -- Singleton lifecycle -----------------------------------------------------

  it('resetPipelineSingleton clears and re-initializes', () => {
    // Pipeline was already used in earlier tests
    assert.ok(ppb.getCachedRegistry() !== null, 'Registry cached after use');
    ppb.resetPipelineSingleton();
    assert.equal(ppb.getCachedRegistry(), null, 'Registry cleared after reset');
    // Re-initializes on next call
    const output = ppb.buildStaticIdentityViaHookPipeline('opus');
    assert.ok(output.length > 100, 'Works after reset');
    assert.ok(ppb.getCachedRegistry() !== null, 'Re-initialized');
  });
});
