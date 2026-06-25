/**
 * F237 Phase 2 AC-P2-5: Strict equality — old builder output === pipeline output.
 *
 * Proves that buildStaticIdentity (legacy if/push) and buildStaticIdentityViaHookPipeline
 * produce whitespace-normalized identical output when given the same inputs.
 *
 * This test is the safety gate for AC-P2-6 delegation: once equivalence is proven,
 * the old functions can safely delegate to the pipeline.
 *
 * Test runs BEFORE delegation (both paths callable independently).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/** Normalize whitespace for comparison: collapse runs of whitespace to single space. */
function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

describe('Strict equality: legacy builder vs pipeline (AC-P2-5/14)', () => {
  /** @type {typeof import('../dist/domains/cats/services/context/SystemPromptBuilder.js')} */
  let legacyBuilder;
  /** @type {typeof import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js')} */
  let pipelineBuilder;
  /** @type {typeof import('@cat-cafe/shared').catRegistry} */
  let catReg;

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;

    // Register test cats (same as dual-path-validation)
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

    legacyBuilder = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    pipelineBuilder = await import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js');
  });

  after(() => {
    catReg?.reset();
    pipelineBuilder?.resetPipelineSingleton();
  });

  it('buildStaticIdentity output matches pipeline output (whitespace-normalized)', () => {
    const legacyOutput = legacyBuilder.buildStaticIdentity('opus', { mcpAvailable: true });
    const pipelineOutput = pipelineBuilder.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: true });

    assert.ok(legacyOutput.length > 500, `Legacy output should be substantial (got ${legacyOutput.length})`);
    assert.ok(pipelineOutput.length > 500, `Pipeline output should be substantial (got ${pipelineOutput.length})`);

    const legacyNorm = normalize(legacyOutput);
    const pipelineNorm = normalize(pipelineOutput);

    // Compare normalized outputs
    if (legacyNorm !== pipelineNorm) {
      // Find first divergence point for debugging
      const minLen = Math.min(legacyNorm.length, pipelineNorm.length);
      let divergeAt = -1;
      for (let i = 0; i < minLen; i++) {
        if (legacyNorm[i] !== pipelineNorm[i]) {
          divergeAt = i;
          break;
        }
      }
      if (divergeAt === -1) divergeAt = minLen;

      const context = 80;
      const legacySnippet = legacyNorm.slice(Math.max(0, divergeAt - context), divergeAt + context);
      const pipelineSnippet = pipelineNorm.slice(Math.max(0, divergeAt - context), divergeAt + context);

      assert.fail(
        `Outputs diverge at char ${divergeAt}:\n` +
          `  Legacy length:   ${legacyNorm.length}\n` +
          `  Pipeline length: ${pipelineNorm.length}\n` +
          `  Legacy around divergence:   ...${legacySnippet}...\n` +
          `  Pipeline around divergence: ...${pipelineSnippet}...`,
      );
    }
  });

  it('buildInvocationContext output matches pipeline output (whitespace-normalized)', () => {
    /** @type {import('../dist/domains/cats/services/context/SystemPromptBuilder.js').InvocationContext} */
    const context = {
      catId: /** @type {any} */ ('opus'),
      mode: /** @type {const} */ ('serial'),
      chainIndex: 1,
      chainTotal: 2,
      teammates: [/** @type {any} */ ('codex')],
      mcpAvailable: true,
      a2aEnabled: true,
      nativeL0Injected: false,
    };

    const legacyOutput = legacyBuilder.buildInvocationContext(context);
    const pipelineOutput = pipelineBuilder.buildInvocationContextViaHookPipeline(context);

    assert.ok(legacyOutput.length > 100, `Legacy output should be substantial (got ${legacyOutput.length})`);
    assert.ok(pipelineOutput.length > 100, `Pipeline output should be substantial (got ${pipelineOutput.length})`);

    const legacyNorm = normalize(legacyOutput);
    const pipelineNorm = normalize(pipelineOutput);

    if (legacyNorm !== pipelineNorm) {
      const minLen = Math.min(legacyNorm.length, pipelineNorm.length);
      let divergeAt = -1;
      for (let i = 0; i < minLen; i++) {
        if (legacyNorm[i] !== pipelineNorm[i]) {
          divergeAt = i;
          break;
        }
      }
      if (divergeAt === -1) divergeAt = minLen;

      const context2 = 80;
      const legacySnippet = legacyNorm.slice(Math.max(0, divergeAt - context2), divergeAt + context2);
      const pipelineSnippet = pipelineNorm.slice(Math.max(0, divergeAt - context2), divergeAt + context2);

      assert.fail(
        `Outputs diverge at char ${divergeAt}:\n` +
          `  Legacy length:   ${legacyNorm.length}\n` +
          `  Pipeline length: ${pipelineNorm.length}\n` +
          `  Legacy around divergence:   ...${legacySnippet}...\n` +
          `  Pipeline around divergence: ...${pipelineSnippet}...`,
      );
    }
  });
});
