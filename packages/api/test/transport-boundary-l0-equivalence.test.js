/**
 * F237 Phase 2: Transport boundary (AC-P2-12) + L0 equivalence (AC-P2-14a)
 *
 * AC-P2-12: Verifies transport assembly (staging/contextHint/missionPrefix/M2)
 * is NOT part of the hook pipeline — these remain in the transport layer.
 *
 * AC-P2-14a: Verifies L0 compiler's L1-L7 template loading produces
 * identical content to HookPipeline's L1-L7 hook execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { before, describe, it } from 'node:test';

describe('Transport boundary + L0 equivalence', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js')} */
  let registryMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/HookPipeline.js')} */
  let pipelineMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let resolversMod;
  /** @type {typeof import('../dist/domains/cats/services/context/prompt-template-loader.js')} */
  let templateMod;
  /** @type {import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let registry;
  /** @type {string} */
  let monorepoRoot;

  before(async () => {
    [registryMod, pipelineMod, resolversMod, templateMod] = await Promise.all([
      import('../dist/domains/prompt-hooks/HookRegistry.js'),
      import('../dist/domains/prompt-hooks/HookPipeline.js'),
      import('../dist/domains/prompt-hooks/resolvers/index.js'),
      import('../dist/domains/cats/services/context/prompt-template-loader.js'),
    ]);
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    monorepoRoot = findMonorepoRoot();
    registry = new registryMod.HookRegistry(
      join(monorepoRoot, 'assets', 'prompt-hooks'),
      join(monorepoRoot, 'assets', 'prompt-templates'),
    );
    registry.scan();
  });

  // -- AC-P2-12: Transport assembly boundary ----------------------------------

  describe('Transport boundary (AC-P2-12)', () => {
    it('pipeline does not contain transport segments (M1, M2, staging)', () => {
      const allHooks = registry.getAllHooks();
      const hookIds = allHooks.map((h) => h.manifest.id);

      // M1/M2 (observe-only) are in trace adapters, not pipeline hooks
      assert.ok(!hookIds.includes('M1'), 'M1 not a pipeline hook');
      assert.ok(!hookIds.includes('M2'), 'M2 not a pipeline hook');

      // No staging/contextHint/missionPrefix hooks
      const transportTerms = ['staging', 'contextHint', 'missionPrefix', 'transport'];
      for (const hook of allHooks) {
        const idLower = hook.manifest.id.toLowerCase();
        for (const term of transportTerms) {
          assert.ok(!idLower.includes(term), `${hook.manifest.id} should not be a transport hook`);
        }
      }
    });

    it('pipeline hooks are only S/D/L/B/C/R/N prefixed', () => {
      const allHooks = registry.getAllHooks();
      const validPrefixes = ['S', 'D', 'L', 'B', 'C', 'R', 'N'];
      for (const hook of allHooks) {
        const prefix = hook.manifest.id.replace(/\d+$/, '');
        assert.ok(validPrefixes.includes(prefix), `${hook.manifest.id} has valid prefix '${prefix}'`);
      }
    });

    it('exactly 46 hooks in the pipeline (no transport leakage)', () => {
      const allHooks = registry.getAllHooks();
      assert.equal(allHooks.length, 46, `Expected 46 hooks, got ${allHooks.length}`);
    });
  });

  // -- AC-P2-14a: L0 compiled output equivalence ------------------------------

  describe('L0 compiled output equivalence (AC-P2-14a)', () => {
    /** L0 section template filenames — same mapping as compile-system-prompt-l0.mjs */
    const L0_SECTION_FILES = {
      L1: 'l1-parallel-world.md',
      L2: 'l2-carry-over.md',
      L3: 'l3-routing-rules.md',
      L4: 'l4-iron-laws.md',
      L5: 'l5-mcp-tools-index.md',
      L6: 'l6-capability-wakeup.md',
      L7: 'l7-collaboration-philosophy.md',
    };

    /**
     * Strip compiler annotation lines — mirrors loadL0SectionTemplate in
     * compile-system-prompt-l0.mjs (strips HTML comments + segment labels).
     */
    function loadL0SectionDirect(filename) {
      const filePath = resolve(monorepoRoot, 'assets', 'prompt-templates', filename);
      const raw = readFileSync(filePath, 'utf8');
      return raw
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('<!--') && !/^── \[[A-Z]\d+] .+──$/.test(trimmed);
        })
        .join('\n')
        .trim();
    }

    /** @returns {import('@cat-cafe/shared').AssemblerInput} */
    function makeMinimalInput() {
      return {
        catId: 'opus',
        catConfig: {
          displayName: '布偶猫',
          nickname: '宪宪',
          name: 'Ragdoll',
          roleDescription: '主架构师',
          personality: '温柔',
          defaultModel: 'claude-opus-4-6',
          mentionPatterns: ['@opus'],
          restrictions: [],
          clientId: 'anthropic',
          breedId: 'ragdoll',
        },
        runtimeModel: 'claude-opus-4-6',
        providerLabel: 'Anthropic',
        callableMentions: { mentions: [], hasDuplicateDisplayNames: false, uniqueHandleExample: null },
        rosterContent: null,
        workflowTriggerContent: null,
        coCreatorName: 'lang',
        coCreatorHandles: '`@lang`',
        governanceDigest: '',
        mcpToolsSection: '',
        packMasksBlock: null,
        packWorkflowsBlock: null,
        packGuardrailBlock: null,
        packDefaultsBlock: null,
        packWorldDriverSummary: null,
        mode: 'independent',
        chainIndex: null,
        chainTotal: null,
        mcpAvailable: false,
        nativeL0Injected: false,
        a2aEnabled: false,
        directMessage: null,
        crossThreadReplyHint: null,
        pingPongWarning: null,
        teammates: [],
        mentionRoutingItems: [],
        promptTags: [],
        activeParticipants: [],
        routingPolicyParts: null,
        sopStageHint: null,
        voiceMode: false,
        bootcampState: null,
        threadId: null,
        bootcampMemberCount: null,
        guidePromptLines: null,
        conciergeLines: null,
        worldContext: null,
        alwaysOnDocsBlock: null,
        activeSignalsBlock: null,
        a2aBallCheckContent: null,
        handoffDecisionTreeContent: null,
        coCreatorFirstMention: '@lang',
      };
    }

    it('L1-L7 pipeline patches match L0 compiler template loading', () => {
      const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
      const result = pipeline.executeStage('session-init', makeMinimalInput());
      const patchMap = Object.fromEntries(result.patches.map((p) => [p.hookId, p.content]));

      for (const [hookId, filename] of Object.entries(L0_SECTION_FILES)) {
        const l0Direct = loadL0SectionDirect(filename);
        const pipelineContent = patchMap[hookId];

        assert.ok(pipelineContent, `${hookId} should produce a pipeline patch`);

        // Normalize whitespace for comparison (both should produce same content
        // after stripping annotations — pipeline uses renderSegment which also
        // strips comments)
        const l0Normalized = l0Direct.replace(/\s+/g, ' ').trim();
        const pipelineNormalized = pipelineContent.replace(/\s+/g, ' ').trim();

        assert.equal(pipelineNormalized, l0Normalized, `${hookId} pipeline output should match L0 direct loading`);
      }
    });

    it('all 7 L-layer hooks fire in session-init stage', () => {
      const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
      const result = pipeline.executeStage('session-init', makeMinimalInput());
      const firedIds = result.events.filter((e) => e.status === 'fired').map((e) => e.hookId);

      for (let i = 1; i <= 7; i++) {
        assert.ok(firedIds.includes(`L${i}`), `L${i} should fire in session-init`);
      }
    });
  });
});
