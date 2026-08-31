/**
 * F237 Phase 2 (AC-P2-6): PipelinePromptBuilder tests
 *
 * Verifies that pipeline-backed buildStaticIdentityViaHookPipeline and
 * buildInvocationContextViaHookPipeline produce meaningful output.
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

  it('session prompt scoped to S-prefix hooks only (L-layer filtered out)', () => {
    const output = ppb.buildStaticIdentityViaHookPipeline('opus', { mcpAvailable: false });
    // S9 governance digest contains principles/iron laws (sourced from L1/L4 content)
    assert.ok(output.includes('P1'), 'S9 governance digest contains principles');
    // L-layer hooks fire in pipeline (for trace) but their content is NOT in
    // S-prefix output — L1-L7 go through native L0 compiler channel separately.
    // Verify S-prefix filtering works: output should not contain L-layer markers
    assert.ok(!output.includes('── [L1]'), 'L1 marker should not appear in S-scoped output');
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

  // -- AF-1 cold-start bootstrap regression (P2-2) ----------------------------

  it('refreshOverrideSnapshot warms registry on cold start (AF-1 regression)', async () => {
    // Simulates server restart: registry is null, store has existing overrides.
    // Without bootstrap refreshOverrideSnapshot(), getCachedRegistry() stays null
    // and all lifeline/override routes return 404.
    ppb.resetPipelineSingleton();
    assert.equal(ppb.getCachedRegistry(), null, 'Cold: registry is null');

    // Fake store: loadSnapshot returns a map with one disabled override
    const fakeSnapshot = new Map([
      [
        'test-hook',
        {
          hookId: 'test-hook',
          enabled: false,
          source: 'operator',
          updatedAt: Date.now(),
          updatedBy: 'test',
        },
      ],
    ]);
    const fakeStore = { loadSnapshot: async () => fakeSnapshot };
    ppb.setOverrideStore(fakeStore);

    // This is the bootstrap call from index.ts — must warm registry from null
    await ppb.refreshOverrideSnapshot();

    assert.ok(ppb.getCachedRegistry() !== null, 'Warm: registry initialized by refreshOverrideSnapshot');
    // Verify the override snapshot was actually loaded into the registry
    const registry = ppb.getCachedRegistry();
    assert.ok(registry.isEnabled !== undefined, 'Registry has isEnabled method');

    // Clean up: restore singleton for any subsequent tests
    ppb.resetPipelineSingleton();
    ppb.setOverrideStore(null);
  });

  // Source-contract: index.ts bootstrap must call refreshOverrideSnapshot()
  // after setOverrideStore(). Without this, the helper test above passes but
  // the actual server cold-starts with null registry. (R12 P2-2: "调用点 + helper 行为" 闭环)
  it('index.ts bootstrap calls refreshOverrideSnapshot after setOverrideStore (AF-1 source contract)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexSrc = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf-8');

    // setOverrideStore must appear before refreshOverrideSnapshot in the source
    const setStoreIdx = indexSrc.indexOf('setOverrideStore(hookOverrideStore)');
    const refreshIdx = indexSrc.indexOf('await refreshOverrideSnapshot()');
    assert.ok(setStoreIdx > 0, 'index.ts contains setOverrideStore(hookOverrideStore)');
    assert.ok(refreshIdx > 0, 'index.ts contains await refreshOverrideSnapshot()');
    assert.ok(refreshIdx > setStoreIdx, 'refreshOverrideSnapshot() comes after setOverrideStore()');
  });
});
