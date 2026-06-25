/**
 * F237 Phase 2-C: Pipeline integration test
 *
 * Runs the real HookPipeline with real HookRegistry, real RESOLVER_MAP,
 * and real renderSegment against the actual assets/prompt-hooks/ manifests
 * and assets/prompt-templates/ files.
 *
 * AC-P2-5: dual-path validation (pipeline output contains same content)
 * AC-P2-7: every hook produces a TraceEvent
 * AC-P2-14: pipeline fires/skips match expected behavior
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/** @returns {import('@cat-cafe/shared').AssemblerInput} */
function makeRichInput(overrides = {}) {
  return {
    catId: 'opus',
    catConfig: {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师和核心开发者',
      personality: '温柔但有主见，喜欢深入分析问题',
      defaultModel: 'claude-opus-4-6',
      variantLabel: undefined,
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    },
    runtimeModel: 'claude-opus-4-6',
    providerLabel: 'Anthropic',
    callableMentions: {
      mentions: ['@codex', '@gemini'],
      hasDuplicateDisplayNames: false,
      uniqueHandleExample: null,
    },
    rosterContent: '## 队友名册\n| 猫猫 | @mention | 擅长 |\n|---|---|---|\n| 缅因猫 | @codex | Review |',
    workflowTriggerContent: '## 工作流\n- 完成开发 → @codex 请 review',
    coCreatorName: 'lang',
    coCreatorHandles: '`@lang` / `@co-creator`',
    governanceDigest: '## 治理摘要\n- 规则1\n- 规则2',
    mcpToolsSection: '## MCP Tools\n- tool1',
    packMasksBlock: null,
    packWorkflowsBlock: null,
    packGuardrailBlock: null,
    packDefaultsBlock: null,
    packWorldDriverSummary: null,
    mode: 'serial',
    chainIndex: 1,
    chainTotal: 2,
    mcpAvailable: true,
    nativeL0Injected: false,
    a2aEnabled: true,
    directMessage: {
      fromCatId: 'codex',
      fromLabel: '缅因猫(codex)',
      fromModel: 'gpt-5.5',
      fromDisplayName: '缅因猫',
      isSameBreed: false,
    },
    crossThreadReplyHint: null,
    pingPongWarning: null,
    teammates: [
      { id: 'codex', displayName: '缅因猫', nickname: '砚砚', name: 'Maine Coon', roleDescription: 'Review' },
    ],
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
    a2aBallCheckContent: '## A2A Ball Check\nBall ownership rules...',
    handoffDecisionTreeContent: null,
    coCreatorFirstMention: '@lang',
    ...overrides,
  };
}

describe('Pipeline Integration (real registry + resolvers + templates)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookPipeline.js')} */
  let pipelineMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js')} */
  let registryMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/index.js')} */
  let resolversMod;
  /** @type {typeof import('../dist/domains/cats/services/context/prompt-template-loader.js')} */
  let templateMod;
  /** @type {import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let registry;

  it('load modules and scan hooks', async () => {
    [pipelineMod, registryMod, resolversMod, templateMod] = await Promise.all([
      import('../dist/domains/prompt-hooks/HookPipeline.js'),
      import('../dist/domains/prompt-hooks/HookRegistry.js'),
      import('../dist/domains/prompt-hooks/resolvers/index.js'),
      import('../dist/domains/cats/services/context/prompt-template-loader.js'),
    ]);
    // Resolve hooks + templates dirs relative to monorepo root
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const root = findMonorepoRoot();
    const hooksDir = join(root, 'assets', 'prompt-hooks');
    const templatesDir = join(root, 'assets', 'prompt-templates');
    registry = new registryMod.HookRegistry(hooksDir, templatesDir);
    const manifests = registry.scan();
    assert.equal(manifests.length, 46, `Expected 46 hooks, got ${manifests.length}`);
  });

  it('session-init stage fires L1-L7 + S1 + S8 + S9 + B1 + C1 (always-fire hooks)', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const input = makeRichInput();
    const result = pipeline.executeStage('session-init', input);

    // All 22 session-init hooks should produce trace events
    assert.equal(result.events.length, 22, `Expected 22 events, got ${result.events.length}`);

    // Always-fire hooks should all be fired
    const firedIds = result.events.filter((e) => e.status === 'fired').map((e) => e.hookId);
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'S1', 'S8', 'S9', 'B1', 'C1']) {
      assert.ok(firedIds.includes(id), `${id} should fire but didn't`);
    }

    // Conditional hooks with data should fire
    assert.ok(firedIds.includes('S4'), 'S4 should fire (callableMentions present)');
    assert.ok(firedIds.includes('S5'), 'S5 should fire (rosterContent present)');
    assert.ok(firedIds.includes('S6'), 'S6 should fire (workflowTriggerContent present)');
    assert.ok(firedIds.includes('S13'), 'S13 should fire (mcpAvailable=true)');

    // S2, S3, S7, S10-S12 should skip (no restrictions, no pack blocks)
    const skippedIds = result.events.filter((e) => e.status === 'skipped').map((e) => e.hookId);
    for (const id of ['S2', 'S3', 'S7', 'S10', 'S11', 'S12']) {
      assert.ok(skippedIds.includes(id), `${id} should skip but didn't`);
    }

    // Fired patches contain expected content
    const patchMap = Object.fromEntries(result.patches.map((p) => [p.hookId, p.content]));
    assert.ok(patchMap.S1.includes('布偶猫'), 'S1 should contain displayName');
    assert.ok(patchMap.S1.includes('宪宪'), 'S1 should contain nickname');
    assert.ok(patchMap.S4.includes('@codex'), 'S4 should contain callable mention');
    assert.ok(patchMap.S5.includes('缅因猫'), 'S5 should contain roster');
    assert.ok(patchMap.S8.includes('lang'), 'S8 should contain co-creator name');
  });

  it('per-turn stage fires D1-D7 and skips appropriately', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const input = makeRichInput();
    const result = pipeline.executeStage('per-turn', input);

    // 24 per-turn hooks should produce trace events
    assert.equal(result.events.length, 24, `Expected 24 events, got ${result.events.length}`);

    const firedIds = result.events.filter((e) => e.status === 'fired').map((e) => e.hookId);

    // D1 always fires
    assert.ok(firedIds.includes('D1'), 'D1 should fire');
    // D2 fires (directMessage present)
    assert.ok(firedIds.includes('D2'), 'D2 should fire (directMessage present)');
    // D3 skips (not same breed)
    assert.ok(!firedIds.includes('D3'), 'D3 should skip (cross-breed)');
    // D6 fires (teammates present)
    assert.ok(firedIds.includes('D6'), 'D6 should fire (teammates present)');
    // D7 fires (always fires)
    assert.ok(firedIds.includes('D7'), 'D7 should fire');
    // D8 fires (serial + a2a + not native L0)
    assert.ok(firedIds.includes('D8'), 'D8 should fire (a2a enabled)');
    // D15 fires (always)
    assert.ok(firedIds.includes('D15'), 'D15 should fire');
    // D21 fires (a2a + serial + not native L0)
    assert.ok(firedIds.includes('D21'), 'D21 should fire (handoff tree)');
    // R1, R2, N1 always fire
    assert.ok(firedIds.includes('R1'), 'R1 should fire');
    assert.ok(firedIds.includes('R2'), 'R2 should fire');
    assert.ok(firedIds.includes('N1'), 'N1 should fire');

    // Content checks
    const patchMap = Object.fromEntries(result.patches.map((p) => [p.hookId, p.content]));
    assert.ok(patchMap.D1.includes('布偶猫'), 'D1 identity anchor');
    assert.ok(patchMap.D1.includes('opus'), 'D1 catId');
    assert.ok(patchMap.D2.includes('缅因猫(codex)'), 'D2 direct message source');
    assert.ok(patchMap.D6.includes('缅因猫/砚砚'), 'D6 teammate list');
  });

  it('TEMPLATE_VARIANT resolution: D7 serial uses d7-mode-serial template', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const input = makeRichInput({ mode: 'serial', chainIndex: 2, chainTotal: 3 });
    const result = pipeline.executeStage('per-turn', input);
    const d7Patch = result.patches.find((p) => p.hookId === 'D7');
    assert.ok(d7Patch, 'D7 should produce a patch');
    assert.ok(d7Patch.content.includes('2'), 'D7 serial should include chain index');
    assert.ok(d7Patch.content.includes('3'), 'D7 serial should include chain total');
  });

  it('every trace event has required fields', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const result = pipeline.executeStage('session-init', makeRichInput());
    for (const event of result.events) {
      assert.ok(event.hookId, 'hookId required');
      assert.ok(event.stage, 'stage required');
      assert.ok(event.timestamp > 0, 'timestamp required');
      assert.ok(['fired', 'skipped', 'disabled'].includes(event.status), 'valid status');
      if (event.status === 'fired') {
        assert.ok(/** @type {any} */ (event).contentHash, 'fired needs contentHash');
        assert.ok(typeof (/** @type {any} */ (event).tokenEstimate) === 'number', 'fired needs tokenEstimate');
      }
      if (event.status === 'skipped') {
        assert.ok(/** @type {any} */ (event).reasonCode, 'skipped needs reasonCode');
      }
    }
  });

  it('assemblePatches produces non-empty output', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const sessionResult = pipeline.executeStage('session-init', makeRichInput());
    const turnResult = pipeline.executeStage('per-turn', makeRichInput());

    const sessionOutput = pipelineMod.HookPipeline.assemblePatches(sessionResult.patches);
    const turnOutput = pipelineMod.HookPipeline.assemblePatches(turnResult.patches);

    assert.ok(sessionOutput.length > 100, 'Session output should be substantial');
    assert.ok(turnOutput.length > 100, 'Turn output should be substantial');
    assert.ok(sessionOutput.includes('布偶猫'), 'Session output includes identity');
    assert.ok(turnOutput.includes('布偶猫'), 'Turn output includes identity anchor');
  });

  // -- Override integration (AC-P2-10/11) -----------------------------------

  it('operator-disabled hook produces TraceEventDisabled with disabledBy=operator', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const overrides = new Map([['D15', { enabled: false, version: 1, templateOverride: null, source: 'operator' }]]);
    const result = pipeline.executeStage('per-turn', makeRichInput(), overrides);
    const d15Event = result.events.find((e) => e.hookId === 'D15');
    assert.ok(d15Event, 'D15 should have a trace event');
    assert.equal(d15Event.status, 'disabled');
    assert.equal(/** @type {any} */ (d15Event).disabledBy, 'operator');
    assert.ok(!result.patches.some((p) => p.hookId === 'D15'), 'D15 should produce no patch');
  });

  it('template override replaces file-based template (AC-P2-10)', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    const customTemplate = '## Custom Voice\nThis is a custom voice mode segment for {{DISPLAY_NAME}}';
    const overrides = new Map([
      ['D15', { enabled: true, version: 2, templateOverride: customTemplate, source: 'operator' }],
    ]);
    const result = pipeline.executeStage('per-turn', makeRichInput(), overrides);
    const d15Patch = result.patches.find((p) => p.hookId === 'D15');
    assert.ok(d15Patch, 'D15 should produce a patch');
    assert.ok(d15Patch.content.includes('Custom Voice'), 'Should use override template');
    // Version should reflect override
    const d15Event = result.events.find((e) => e.hookId === 'D15' && e.status === 'fired');
    assert.ok(d15Event);
    assert.equal(/** @type {any} */ (d15Event).version, 2, 'Version from override');
  });

  it('without overrides map, pipeline uses baseline (backward-compatible)', () => {
    const pipeline = new pipelineMod.HookPipeline(registry, resolversMod.RESOLVER_MAP, templateMod.renderSegment);
    // Call without overrides — should work exactly as before
    const result = pipeline.executeStage('session-init', makeRichInput());
    assert.equal(result.events.length, 22, 'Same 22 session-init events');
    const firedIds = result.events.filter((e) => e.status === 'fired').map((e) => e.hookId);
    assert.ok(firedIds.includes('S1'), 'S1 fires from baseline');
  });
});
