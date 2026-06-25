/**
 * F237 Phase 2 AC-P2-14a: L0 compiler ↔ pipeline L-hook equivalence.
 *
 * Proves that the L0 compiler's loadL0SectionTemplate() output for L1-L7
 * matches the pipeline's L-hook patch content (whitespace-normalized).
 *
 * When this test passes, the L0 compiler can safely switch to consuming
 * pipeline-produced L-hook content instead of reading template files directly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

/** Normalize whitespace for comparison. */
function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip compiler-only annotation lines (same as L0 compiler's logic). */
function stripAnnotations(raw) {
  const SEGMENT_LABEL = /^── \[[A-Z]\d+] .+──$/;
  return raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('<!--') && !SEGMENT_LABEL.test(trimmed);
    })
    .join('\n')
    .trim();
}

describe('L0 compiler ↔ pipeline L-hook equivalence (AC-P2-14a)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookPipeline.js')} */
  let HookPipelineMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js')} */
  let HookRegistryMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let resolverIndex;
  /** @type {typeof import('../dist/domains/cats/services/context/prompt-template-loader.js')} */
  let templateLoader;
  /** @type {typeof import('../dist/domains/prompt-hooks/assemble-bridge.js')} */
  let assembleBridge;
  /** @type {typeof import('../dist/utils/monorepo-root.js')} */
  let monorepoRoot;
  /** @type {typeof import('@cat-cafe/shared').catRegistry} */
  let catReg;

  /** L0 compiler's mapping of L-section template files. */
  const L0_SECTIONS = {
    L1: 'l1-parallel-world.md',
    L2: 'l2-carry-over.md',
    L3: 'l3-routing-rules.md',
    L4: 'l4-iron-laws.md',
    L5: 'l5-mcp-tools-index.md',
    L6: 'l6-capability-wakeup.md',
    L7: 'l7-collaboration-philosophy.md',
  };

  before(async () => {
    const shared = await import('@cat-cafe/shared');
    catReg = shared.catRegistry;
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

    HookPipelineMod = await import('../dist/domains/prompt-hooks/HookPipeline.js');
    HookRegistryMod = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    resolverIndex = await import('../dist/domains/prompt-hooks/resolvers/index.js');
    templateLoader = await import('../dist/domains/cats/services/context/prompt-template-loader.js');
    assembleBridge = await import('../dist/domains/prompt-hooks/assemble-bridge.js');
    monorepoRoot = await import('../dist/utils/monorepo-root.js');
  });

  after(() => {
    catReg?.reset();
  });

  it('L1-L7 pipeline patches match L0 compiler template output', () => {
    const root = monorepoRoot.findMonorepoRoot();
    const templatesDir = join(root, 'assets', 'prompt-templates');

    // Pipeline: execute session-init and extract L-hook patches
    const registry = new HookRegistryMod.HookRegistry(join(root, 'assets', 'prompt-hooks'), templatesDir);
    registry.scan();
    const pipeline = new HookPipelineMod.HookPipeline(
      registry,
      resolverIndex.RESOLVER_MAP,
      templateLoader.renderSegment,
    );
    const input = assembleBridge.assembleForSession('opus', { mcpAvailable: true });
    const result = pipeline.executeStage('session-init', input);

    const pipelinePatches = {};
    for (const patch of result.patches) {
      if (/^L\d$/.test(patch.hookId)) {
        pipelinePatches[patch.hookId] = patch.content;
      }
    }

    // Compare each L-section
    const mismatches = [];
    for (const [hookId, templateFile] of Object.entries(L0_SECTIONS)) {
      const filePath = resolve(templatesDir, templateFile);
      const l0Content = stripAnnotations(readFileSync(filePath, 'utf-8'));
      const pipelineContent = pipelinePatches[hookId];

      if (!pipelineContent) {
        mismatches.push(`${hookId}: pipeline patch MISSING (L0 template: ${l0Content.length} chars)`);
        continue;
      }

      const l0Norm = normalize(l0Content);
      const pipeNorm = normalize(pipelineContent);

      if (l0Norm !== pipeNorm) {
        // Find divergence point
        const minLen = Math.min(l0Norm.length, pipeNorm.length);
        let d = 0;
        while (d < minLen && l0Norm[d] === pipeNorm[d]) d++;
        mismatches.push(
          `${hookId}: DIVERGE at char ${d}\n` +
            `  L0:       ${l0Norm.length} chars — ...${l0Norm.slice(Math.max(0, d - 40), d + 40)}...\n` +
            `  Pipeline: ${pipeNorm.length} chars — ...${pipeNorm.slice(Math.max(0, d - 40), d + 40)}...`,
        );
      }
    }

    if (mismatches.length > 0) {
      assert.fail(`L0 ↔ pipeline mismatches:\n${mismatches.join('\n')}`);
    }

    // Verify all 7 L-hooks produced output
    const lHookIds = Object.keys(pipelinePatches).sort();
    assert.deepStrictEqual(lHookIds, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'], 'All L1-L7 hooks should fire');
  });
});
