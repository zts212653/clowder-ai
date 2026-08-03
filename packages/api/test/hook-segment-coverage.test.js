/**
 * Hook segment coverage + pipeline smoke tests (AC-P2-14).
 *
 * Verifies that PipelinePromptBuilder produces the correct structural output:
 * - **Segment coverage**: every expected S/D-prefix hook produces non-empty
 *   content (catches silent drops during refactoring)
 * - Specific segment content from known hooks (identity, mentions, governance)
 * - Correct hook event counts matching the 46-hook manifest catalog
 * - S-prefix scope filtering (L/B/C hooks executed but not in output)
 * - D-prefix scope filtering (R/N hooks executed but not in output)
 * - Trace capture drains correctly (no stale buffer)
 *
 * NOTE: v0 (SystemPromptBuilder) delegates to PipelinePromptBuilder — there is
 * no independent v0 path to compare. "Segment coverage" means each hook fires
 * and produces content, not that two paths agree.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

describe('Hook segment coverage (AC-P2-14)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/PipelinePromptBuilder.js')} */
  let ppb;
  /** @type {typeof import('@cat-cafe/shared').catRegistry} */
  let catReg;

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

  // -- Hook content coverage (golden equality) ---------------------------------
  // Every S-prefix hook must produce a non-empty patch — if a refactoring
  // silently drops a hook's resolver or its input wiring, this test catches it.
  // This is the "strict equality" the file name promises: not v0-vs-pipeline
  // (they share a code path now) but "every hook contributes content."

  /**
   * S-prefix hooks expected to fire for a standard opus config with
   * mcpAvailable=true, no restrictions, no pack masks.
   * Conditional hooks (S2=restrictions, S3=packMasks, S7/S10-S12=optional inputs)
   * correctly skip and are NOT listed here.
   */
  const EXPECTED_S_HOOKS = [
    'S1', // identity declaration
    'S4', // collaboration format / callable mentions
    'S5', // workflow triggers
    'S6', // MCP tool documentation
    'S8', // co-creator reference
    'S9', // governance digest
    'S13', // staging layer
  ];

  /**
   * D-prefix hooks expected to fire for a standard serial invocation with
   * teammates, a2aEnabled, mcpAvailable.
   * Most D-hooks are conditional on thread state / invocation metadata not
   * present in the test fixture.
   */
  const EXPECTED_D_HOOKS = [
    'D1', // identity anchor
    'D6', // teammates/chain context
    'D7', // mode declaration
    'D8', // A2A routing format
    'D15', // invocation metadata
    'D21', // trailing anchor
  ];

  // -- Golden snapshot: content anchors per hook --------------------------------
  // Stronger than non-empty: asserts each hook's content contains specific
  // distinctive substrings. If a refactoring silently drops or corrupts a
  // section, these anchors catch it — unlike length/includes smoke checks.

  /** Per-hook content anchors — distinctive strings that MUST appear. */
  const S_CONTENT_ANCHORS = {
    S1: ['布偶猫/宪宪', 'Ragdoll', '主架构师和核心开发者'],
    S4: ['@codex', '@队友'],
    S5: ['队友名册'],
    S6: ['工作流', '@ 触发点'],
    S8: ['co-creator'],
    S9: ['家规', 'Rule 0', 'P1', 'Magic Words'],
    S13: ['MCP 工具'],
  };

  const D_CONTENT_ANCHORS = {
    D1: ['布偶猫/宪宪', '@opus', 'claude-opus-4-6'],
    D6: ['缅因猫/砚砚'],
    D7: ['当前模式'],
    D8: ['球权', '@句柄'],
    D15: ['Voice Mode'],
    D21: ['传球决策树', '@co-creator'],
  };

  it('S-hook content matches golden anchors (content drift detection)', () => {
    const { trace } = ppb.buildStaticIdentityViaHookPipelineWithTrace('opus', { mcpAvailable: true });
    const patchMap = new Map(trace.patches.map((p) => [p.hookId, p.content]));

    for (const [hookId, anchors] of Object.entries(S_CONTENT_ANCHORS)) {
      const content = patchMap.get(hookId) ?? '';
      for (const anchor of anchors) {
        assert.ok(
          content.includes(anchor),
          `${hookId} golden anchor missing: expected "${anchor}" in content (got ${content.length} chars, first 80: ${JSON.stringify(content.slice(0, 80))})`,
        );
      }
    }
  });

  it('D-hook content matches golden anchors (content drift detection)', () => {
    const { trace } = ppb.buildInvocationContextViaHookPipelineWithTrace({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    const patchMap = new Map(trace.patches.map((p) => [p.hookId, p.content]));

    for (const [hookId, anchors] of Object.entries(D_CONTENT_ANCHORS)) {
      const content = patchMap.get(hookId) ?? '';
      for (const anchor of anchors) {
        assert.ok(
          content.includes(anchor),
          `${hookId} golden anchor missing: expected "${anchor}" in content (got ${content.length} chars, first 80: ${JSON.stringify(content.slice(0, 80))})`,
        );
      }
    }
  });

  // -- Segment fire coverage ---------------------------------------------------

  it('every expected S-prefix hook produces non-empty content (segment coverage)', () => {
    const { trace } = ppb.buildStaticIdentityViaHookPipelineWithTrace('opus', { mcpAvailable: true });
    const patchMap = new Map(trace.patches.map((p) => [p.hookId, p.content]));

    for (const hookId of EXPECTED_S_HOOKS) {
      const content = patchMap.get(hookId);
      assert.ok(
        content && content.trim().length > 0,
        `${hookId} must produce non-empty content but got: ${content === undefined ? 'no patch' : JSON.stringify(content.slice(0, 80))}`,
      );
    }
  });

  it('every expected D-prefix hook produces non-empty content (segment coverage)', () => {
    const { trace } = ppb.buildInvocationContextViaHookPipelineWithTrace({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    const patchMap = new Map(trace.patches.map((p) => [p.hookId, p.content]));

    for (const hookId of EXPECTED_D_HOOKS) {
      const content = patchMap.get(hookId);
      assert.ok(
        content && content.trim().length > 0,
        `${hookId} must produce non-empty content but got: ${content === undefined ? 'no patch' : JSON.stringify(content.slice(0, 80))}`,
      );
    }
  });

  // -- Session-init scope filtering ------------------------------------------

  it('session output contains S-prefix hook content (S1 identity, S4 collab, S8 co-creator, S9 governance)', () => {
    const output = ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: true });
    // S1: Identity declaration
    assert.ok(output.includes('布偶猫'), 'S1 identity: display name');
    assert.ok(output.includes('宪宪'), 'S1 identity: nickname');
    // S4: Collaboration format (callable mentions)
    assert.ok(output.includes('@codex'), 'S4 collaboration: callable mention');
    // S9: Governance digest (principles)
    assert.ok(output.length > 500, `Session output substantial (got ${output.length})`);
  });

  it('session output excludes L/B/C/N hook content (scope filtering)', () => {
    const { trace } = ppb.buildStaticIdentityViaHookPipelineWithTrace('opus', { mcpAvailable: true });
    // Pipeline executes ALL hooks for trace coverage
    const allHookIds = trace.events.map((e) => e.hookId);
    const hasLHooks = allHookIds.some((id) => /^L\d/.test(id));
    const hasBHooks = allHookIds.some((id) => /^B\d/.test(id));
    assert.ok(hasLHooks, 'L-hooks should be in trace events');
    assert.ok(hasBHooks, 'B-hooks should be in trace events');
    // But S-prefix output should not include L/B/C markers
    const output = ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: true });
    assert.ok(!output.includes('── [L1]'), 'L1 marker excluded from S-scoped output');
    assert.ok(!output.includes('── [B1]'), 'B1 marker excluded from S-scoped output');
  });

  it('session trace produces exactly 22 session-init events', () => {
    const { trace } = ppb.buildStaticIdentityViaHookPipelineWithTrace('opus', { mcpAvailable: true });
    assert.equal(trace.events.length, 22, `Expected 22 session-init events, got ${trace.events.length}`);
  });

  // -- Per-turn scope filtering ----------------------------------------------

  it('per-turn output contains D-prefix hook content (D1 anchor, D7 mode)', () => {
    const output = ppb.buildInvocationContextViaHookPipeline({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    // D1: Identity anchor
    assert.ok(output.includes('布偶猫'), 'D1 identity anchor in turn output');
    assert.ok(output.length > 100, `Turn output substantial (got ${output.length})`);
  });

  it('per-turn output excludes R/N hook content (scope filtering)', () => {
    const { trace } = ppb.buildInvocationContextViaHookPipelineWithTrace({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    // R1, R2, N1 should be in trace events but not in D-scoped output
    const allHookIds = trace.events.map((e) => e.hookId);
    assert.ok(allHookIds.includes('R1'), 'R1 in trace events');
    assert.ok(allHookIds.includes('N1'), 'N1 in trace events');
    // D-prefix patches should not include R/N
    const dPatches = trace.patches.filter((p) => /^D\d/.test(p.hookId));
    const rPatches = trace.patches.filter((p) => /^R\d/.test(p.hookId));
    assert.ok(dPatches.length > 0, 'D-prefix patches present');
    assert.ok(rPatches.length > 0, 'R-prefix patches present (in full trace)');
    // But assembled output uses only D-prefix
    const output = ppb.buildInvocationContextViaHookPipeline({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    for (const rPatch of rPatches) {
      // R-prefix content should not appear verbatim in D-scoped output
      // (unless coincidentally overlapping with D-prefix content)
      assert.ok(!output.includes(`── [${rPatch.hookId}]`), `${rPatch.hookId} marker excluded`);
    }
  });

  it('per-turn trace produces exactly 24 per-turn events', () => {
    const { trace } = ppb.buildInvocationContextViaHookPipelineWithTrace({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
      a2aEnabled: true,
    });
    assert.equal(trace.events.length, 24, `Expected 24 per-turn events, got ${trace.events.length}`);
  });

  // -- Trace capture (AC-P2-8) -----------------------------------------------

  it('drainCapturedTraces returns captured data and clears buffer', () => {
    // Build triggers capture
    ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: true });
    const first = ppb.drainCapturedTraces();
    assert.ok(first.session, 'Session trace should be captured');
    assert.ok(first.session.events.length > 0, 'Session events captured');
    // All captured events should be S-prefix (scope filtering)
    for (const ev of first.session.events) {
      assert.ok(/^S\d/.test(ev.hookId), `Captured session event ${ev.hookId} should be S-prefix`);
    }
    // Second drain returns null (buffer cleared)
    const second = ppb.drainCapturedTraces();
    assert.equal(second.session, null, 'Buffer cleared after drain');
  });
});
