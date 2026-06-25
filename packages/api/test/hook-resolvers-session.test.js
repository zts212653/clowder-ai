/**
 * F237 Phase 2-B: Session-init resolver tests (L1-L7, S1-S13, B1, C1)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** @returns {import('@cat-cafe/shared').AssemblerInput} */
function makeInput(overrides = {}) {
  return {
    catId: 'opus',
    catConfig: {
      displayName: '布偶猫',
      nickname: '宪宪',
      name: 'Ragdoll',
      roleDescription: '主架构师',
      personality: '温柔但有主见',
      defaultModel: 'claude-opus-4-6',
      variantLabel: undefined,
      mentionPatterns: ['@opus', '@布偶猫'],
      restrictions: [],
      clientId: 'anthropic',
      breedId: 'ragdoll',
    },
    runtimeModel: 'claude-opus-4-6',
    providerLabel: 'Anthropic',
    callableMentions: { mentions: ['@codex', '@gemini'], hasDuplicateDisplayNames: false, uniqueHandleExample: null },
    rosterContent: '| 猫猫 | @mention | 擅长 | 注意 |\n|---|---|---|---|\n| 缅因猫 | @codex | Review | — |',
    workflowTriggerContent: null,
    coCreatorName: 'lang',
    coCreatorHandles: '`@lang` / `@co-creator`',
    governanceDigest: '## 家规摘要\n- 规则1\n- 规则2',
    mcpToolsSection: '## MCP Tools\n- tool1\n- tool2',
    packMasksBlock: null,
    packWorkflowsBlock: null,
    packGuardrailBlock: null,
    packDefaultsBlock: null,
    packWorldDriverSummary: null,
    mode: 'independent',
    chainIndex: null,
    chainTotal: null,
    mcpAvailable: true,
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
    ...overrides,
  };
}

describe('Layer resolvers (L1-L7)', () => {
  it('L1-L7 always fire with empty vars', async () => {
    const { L1Resolver, L2Resolver, L3Resolver, L4Resolver, L5Resolver, L6Resolver, L7Resolver } = await import(
      '../dist/domains/prompt-hooks/resolvers/layer-resolvers.js'
    );
    const input = makeInput();
    for (const Cls of [L1Resolver, L2Resolver, L3Resolver, L4Resolver, L5Resolver, L6Resolver, L7Resolver]) {
      const r = new Cls();
      const result = r.resolve(input);
      assert.equal(result.status, 'fired');
      assert.deepEqual(result.vars, {});
    }
  });
});

describe('Session resolvers (S1-S13)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/session-resolvers.js')} */
  let mod;

  it('load module', async () => {
    mod = await import('../dist/domains/prompt-hooks/resolvers/session-resolvers.js');
  });

  it('S1 always fires with identity vars', () => {
    const r = new mod.S1Resolver();
    const result = r.resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.NAME_LABEL.includes('宪宪'));
    assert.ok(result.vars.NAME_LABEL.includes('布偶猫'));
    assert.equal(result.vars.PROVIDER_LABEL, 'Anthropic');
    assert.ok(result.vars.NICKNAME_ORIGIN.includes('宪宪'));
    assert.equal(result.vars.ROLE_DESCRIPTION, '主架构师');
  });

  it('S1 without nickname omits nickname parts', () => {
    const r = new mod.S1Resolver();
    const input = makeInput({ catConfig: { ...makeInput().catConfig, nickname: undefined } });
    const result = r.resolve(input);
    assert.equal(result.status, 'fired');
    assert.ok(!result.vars.NAME_LABEL.includes('/'));
    assert.equal(result.vars.NICKNAME_ORIGIN, '');
  });

  it('S2 fires when restrictions present', () => {
    const r = new mod.S2Resolver();
    const input = makeInput({ catConfig: { ...makeInput().catConfig, restrictions: ['禁止写代码', '禁止审批'] } });
    const result = r.resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.RESTRICTIONS_TEXT, '禁止写代码、禁止审批');
  });

  it('S2 skips when no restrictions', () => {
    const r = new mod.S2Resolver();
    assert.equal(r.resolve(makeInput()).status, 'skipped');
  });

  it('S3 fires with pack masks', () => {
    const r = new mod.S3Resolver();
    const result = r.resolve(makeInput({ packMasksBlock: '## Masks\n- mask1' }));
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.PACK_MASKS_BLOCK.includes('mask1'));
  });

  it('S3 skips without pack masks', () => {
    assert.equal(new mod.S3Resolver().resolve(makeInput()).status, 'skipped');
  });

  it('S4 fires with callable mentions', () => {
    const r = new mod.S4Resolver();
    const result = r.resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.CALLABLE_MENTIONS.includes('@codex'));
    assert.equal(result.vars.EXAMPLE_TARGET, '@codex');
  });

  it('S4 skips with empty mentions', () => {
    const input = makeInput({
      callableMentions: { mentions: [], hasDuplicateDisplayNames: false, uniqueHandleExample: null },
    });
    assert.equal(new mod.S4Resolver().resolve(input).status, 'skipped');
  });

  it('S4 includes duplicate hint when hasDuplicateDisplayNames', () => {
    const input = makeInput({
      callableMentions: {
        mentions: ['@opus', '@opus45'],
        hasDuplicateDisplayNames: true,
        uniqueHandleExample: '@opus45',
      },
    });
    const result = new mod.S4Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.DUPLICATE_NAMES_HINT.includes('@opus45'));
  });

  it('S5 fires with roster', () => {
    const result = new mod.S5Resolver().resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.ROSTER_CONTENT.includes('缅因猫'));
  });

  it('S5 skips without roster', () => {
    assert.equal(new mod.S5Resolver().resolve(makeInput({ rosterContent: null })).status, 'skipped');
  });

  it('S6 fires with workflow triggers', () => {
    const input = makeInput({ workflowTriggerContent: '## 工作流\n- review done → @codex' });
    const result = new mod.S6Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.CONTENT.includes('review done'));
  });

  it('S6 skips without triggers', () => {
    assert.equal(new mod.S6Resolver().resolve(makeInput()).status, 'skipped');
  });

  it('S7 fires with pack workflows', () => {
    const input = makeInput({ packWorkflowsBlock: '## Pack WF' });
    assert.equal(new mod.S7Resolver().resolve(input).status, 'fired');
  });

  it('S8 always fires with co-creator info', () => {
    const result = new mod.S8Resolver().resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.CC_NAME, 'lang');
  });

  it('S9 always fires with governance digest', () => {
    const result = new mod.S9Resolver().resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.GOVERNANCE_DIGEST.includes('家规'));
  });

  it('S10-S12 conditional on pack blocks', () => {
    const input = makeInput({
      packGuardrailBlock: 'guard',
      packDefaultsBlock: 'defaults',
      packWorldDriverSummary: 'world',
    });
    assert.equal(new mod.S10Resolver().resolve(input).status, 'fired');
    assert.equal(new mod.S11Resolver().resolve(input).status, 'fired');
    assert.equal(new mod.S12Resolver().resolve(input).status, 'fired');
    // All skip without pack blocks
    assert.equal(new mod.S10Resolver().resolve(makeInput()).status, 'skipped');
    assert.equal(new mod.S11Resolver().resolve(makeInput()).status, 'skipped');
    assert.equal(new mod.S12Resolver().resolve(makeInput()).status, 'skipped');
  });

  it('S13 fires when MCP available', () => {
    assert.equal(new mod.S13Resolver().resolve(makeInput({ mcpAvailable: true })).status, 'fired');
    assert.equal(new mod.S13Resolver().resolve(makeInput({ mcpAvailable: false })).status, 'skipped');
  });

  it('B1 and C1 always fire', () => {
    const input = makeInput();
    assert.equal(new mod.B1Resolver().resolve(input).status, 'fired');
    assert.equal(new mod.C1Resolver().resolve(input).status, 'fired');
  });
});
