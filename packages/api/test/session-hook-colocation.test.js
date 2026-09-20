/** F257 S5: L1-L7 manifests, templates, and runtime output share one source. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/** Normalize whitespace for comparison. */
function normalize(s) {
  return s.replace(/\s+/g, ' ').trim();
}

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

describe('co-located session hooks', () => {
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

  const SESSION_HOOK_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

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

  it('L1-L7 pipeline patches come from templates beside their manifests', () => {
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

    const mismatches = [];
    for (const hookId of SESSION_HOOK_IDS) {
      const hook = registry.getHook(hookId);
      assert.ok(hook, `${hookId} registered`);
      assert.equal(dirname(hook.templatePath), hook.dirPath, `${hookId} template is co-located with hook.yaml`);
      const sourceContent = stripAnnotations(readFileSync(hook.templatePath, 'utf-8'));
      const pipelineContent = pipelinePatches[hookId];

      if (!pipelineContent) {
        mismatches.push(`${hookId}: pipeline patch MISSING (${sourceContent.length} source chars)`);
        continue;
      }

      const sourceNorm = normalize(sourceContent);
      const pipeNorm = normalize(pipelineContent);

      if (sourceNorm !== pipeNorm) {
        // Find divergence point
        const minLen = Math.min(sourceNorm.length, pipeNorm.length);
        let d = 0;
        while (d < minLen && sourceNorm[d] === pipeNorm[d]) d++;
        mismatches.push(
          `${hookId}: DIVERGE at char ${d}\n` +
            `  Source:   ${sourceNorm.length} chars — ...${sourceNorm.slice(Math.max(0, d - 40), d + 40)}...\n` +
            `  Pipeline: ${pipeNorm.length} chars — ...${pipeNorm.slice(Math.max(0, d - 40), d + 40)}...`,
        );
      }
    }

    if (mismatches.length > 0) {
      assert.fail(`Hook source ↔ pipeline mismatches:\n${mismatches.join('\n')}`);
    }

    // Verify all 7 L-hooks produced output
    const lHookIds = Object.keys(pipelinePatches).sort();
    assert.deepStrictEqual(lHookIds, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'], 'All L1-L7 hooks should fire');
  });
});
