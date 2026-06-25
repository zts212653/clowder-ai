/**
 * F237 Phase 2-B: Per-turn resolver tests (D1-D21, R1-R2, N1)
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
      mentionPatterns: ['@opus'],
      restrictions: [],
      clientId: 'anthropic',
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
    ...overrides,
  };
}

describe('Turn resolvers D1-D10', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/turn-resolvers-a.js')} */
  let mod;

  it('load module', async () => {
    mod = await import('../dist/domains/prompt-hooks/resolvers/turn-resolvers-a.js');
  });

  it('D1 always fires with identity anchor', () => {
    const result = new mod.D1Resolver().resolve(makeInput());
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.DISPLAY_NAME, '布偶猫');
    assert.equal(result.vars.NICKNAME_PART, '/宪宪');
    assert.equal(result.vars.CAT_ID, 'opus');
    assert.equal(result.vars.RUNTIME_MODEL, 'claude-opus-4-6');
  });

  it('D2 fires with direct message', () => {
    const input = makeInput({
      directMessage: {
        fromCatId: 'codex',
        fromLabel: '缅因猫(codex)',
        fromModel: 'gpt-5.5',
        fromDisplayName: '缅因猫',
        isSameBreed: false,
      },
    });
    const result = new mod.D2Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.FROM_LABEL, '缅因猫(codex)');
    assert.equal(result.vars.FROM_MODEL, 'gpt-5.5');
  });

  it('D2 skips without direct message', () => {
    assert.equal(new mod.D2Resolver().resolve(makeInput()).status, 'skipped');
  });

  it('D3 fires for same-breed handoff', () => {
    const input = makeInput({
      directMessage: {
        fromCatId: 'opus45',
        fromLabel: '布偶猫 Opus 4.5(opus45)',
        fromModel: 'claude-opus-4-5',
        fromDisplayName: '布偶猫',
        fromVariantLabel: 'Opus 4.5',
        isSameBreed: true,
      },
    });
    const result = new mod.D3Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.FROM_VARIANT, 'Opus 4.5');
  });

  it('D3 skips for cross-breed handoff', () => {
    const input = makeInput({
      directMessage: {
        fromCatId: 'codex',
        fromLabel: '缅因猫(codex)',
        fromModel: 'gpt-5.5',
        fromDisplayName: '缅因猫',
        isSameBreed: false,
      },
    });
    assert.equal(new mod.D3Resolver().resolve(input).status, 'skipped');
  });

  it('D4 fires with cross-thread hint', () => {
    const input = makeInput({
      crossThreadReplyHint: { sourceThreadId: 'thread-abc', senderCatId: 'codex', effectClass: 'fyi' },
    });
    const result = new mod.D4Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.SOURCE_THREAD, 'thread-abc');
    assert.ok(result.vars.CONSTRAINT_TEXT.includes('effect=fyi'));
  });

  it('D4 skips without cross-thread hint', () => {
    assert.equal(new mod.D4Resolver().resolve(makeInput()).status, 'skipped');
  });

  it('D5 fires with ping-pong warning', () => {
    const input = makeInput({ pingPongWarning: { otherLabel: '缅因猫(codex)', count: 3 } });
    const result = new mod.D5Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.STREAK_COUNT, '3');
  });

  it('D6 fires with teammates', () => {
    const input = makeInput({
      teammates: [
        { id: 'codex', displayName: '缅因猫', nickname: '砚砚', name: 'Maine Coon', roleDescription: 'Review' },
      ],
    });
    const result = new mod.D6Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.TEAMMATES_LIST.includes('缅因猫/砚砚'));
  });

  it('D7 fires serial mode', () => {
    const input = makeInput({ mode: 'serial', chainIndex: 2, chainTotal: 3 });
    const result = new mod.D7Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.TEMPLATE_VARIANT, 'D7_serial');
    assert.equal(result.vars.CHAIN_INDEX, '2');
  });

  it('D7 fires parallel mode', () => {
    const input = makeInput({ mode: 'parallel' });
    const result = new mod.D7Resolver().resolve(input);
    assert.equal(result.vars.TEMPLATE_VARIANT, 'D7_parallel');
  });

  it('D7 fires solo mode', () => {
    const result = new mod.D7Resolver().resolve(makeInput());
    assert.equal(result.vars.TEMPLATE_VARIANT, 'D7_solo');
  });

  it('D8 fires when a2a needed and not native L0', () => {
    const input = makeInput({
      mode: 'serial',
      a2aEnabled: true,
      nativeL0Injected: false,
      a2aBallCheckContent: '## Ball Check',
    });
    const result = new mod.D8Resolver().resolve(input);
    assert.equal(result.status, 'fired');
  });

  it('D8 skips in parallel mode', () => {
    const input = makeInput({ mode: 'parallel', a2aEnabled: true, a2aBallCheckContent: '## Ball Check' });
    assert.equal(new mod.D8Resolver().resolve(input).status, 'skipped');
  });

  it('D8 skips when native L0 injected', () => {
    const input = makeInput({ mode: 'serial', a2aEnabled: true, nativeL0Injected: true });
    assert.equal(new mod.D8Resolver().resolve(input).status, 'skipped');
  });

  it('D9 fires with routing feedback items', () => {
    const input = makeInput({ mentionRoutingItems: ['@unknown1', '@unknown2', '@unknown3'] });
    const result = new mod.D9Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    // Only first 2 items
    assert.equal(result.vars.UNROUTED_MENTIONS, '@unknown1、@unknown2');
  });

  it('D10 fires with critique tag', () => {
    const input = makeInput({ promptTags: ['critique'] });
    assert.equal(new mod.D10Resolver().resolve(input).status, 'fired');
  });

  it('D10 skips without critique tag', () => {
    assert.equal(new mod.D10Resolver().resolve(makeInput()).status, 'skipped');
  });
});

describe('Turn resolvers D11-D21, R1-R2, N1', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/resolvers/turn-resolvers-b.js')} */
  let mod;

  it('load module', async () => {
    mod = await import('../dist/domains/prompt-hooks/resolvers/turn-resolvers-b.js');
  });

  it('D11 fires with skill tag', () => {
    const input = makeInput({ promptTags: ['skill:tdd'] });
    const result = new mod.D11Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.SKILL_NAME, 'tdd');
  });

  it('D12 fires with qualifying active participant', () => {
    const input = makeInput({
      activeParticipants: [
        { catId: 'codex', label: '缅因猫(codex)', lastMessageAt: 1000 },
        { catId: 'opus', label: '布偶猫(opus)', lastMessageAt: 2000 },
      ],
    });
    const result = new mod.D12Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.ACTIVE_LABEL, '缅因猫(codex)');
  });

  it('D12 skips when only self is active', () => {
    const input = makeInput({
      activeParticipants: [{ catId: 'opus', label: '布偶猫(opus)', lastMessageAt: 1000 }],
    });
    assert.equal(new mod.D12Resolver().resolve(input).status, 'skipped');
  });

  it('D13 fires with routing policy', () => {
    const input = makeInput({ routingPolicyParts: 'review avoid @codex (recent conflict)' });
    const result = new mod.D13Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.ok(result.vars.ROUTING_PARTS.includes('avoid @codex'));
  });

  it('D14 fires with SOP hint', () => {
    const input = makeInput({
      sopStageHint: {
        featureId: 'F237',
        stage: 'implement',
        suggestedSkill: 'tdd',
        suggestedSkillSource: 'mission-hub',
      },
    });
    const result = new mod.D14Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.FEATURE_ID, 'F237');
    assert.ok(result.vars.SOURCE_PART.includes('mission-hub'));
  });

  it('D15 always fires — voice on', () => {
    const result = new mod.D15Resolver().resolve(makeInput({ voiceMode: true }));
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.TEMPLATE_VARIANT, 'D15_on');
  });

  it('D15 always fires — voice off', () => {
    const result = new mod.D15Resolver().resolve(makeInput());
    assert.equal(result.vars.TEMPLATE_VARIANT, 'D15_off');
  });

  it('D16 fires with bootcamp state', () => {
    const input = makeInput({
      bootcampState: { phase: 'explore', leadCat: 'opus', selectedTaskId: 'task-1' },
      threadId: 'thread-abc',
      bootcampMemberCount: 3,
    });
    const result = new mod.D16Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.PHASE, 'explore');
    assert.ok(result.vars.THREAD_PART.includes('thread-abc'));
    assert.ok(result.vars.MEMBERS_PART.includes('3'));
  });

  it('D17 fires with guide lines', () => {
    const input = makeInput({ guidePromptLines: '## Guide: Getting Started\nStep 1...' });
    assert.equal(new mod.D17Resolver().resolve(input).status, 'fired');
  });

  it('D18 fires with world context', () => {
    const input = makeInput({
      worldContext: {
        worldName: 'Testworld',
        worldStatus: 'active',
        constitutionLine: 'Constitution: Be kind',
        sceneName: 'Scene1',
        sceneStatus: 'active',
        charactersBlock: 'Characters:\n- Alice',
        canonBlock: '',
        recentEventsBlock: '',
        careHintLine: '',
      },
    });
    const result = new mod.D18Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.WORLD_NAME, 'Testworld');
  });

  it('D19 fires with always-on docs', () => {
    const input = makeInput({ alwaysOnDocsBlock: '### Doc1\n\nContent' });
    assert.equal(new mod.D19Resolver().resolve(input).status, 'fired');
  });

  it('D20 fires with signals', () => {
    const input = makeInput({ activeSignalsBlock: '### [S1] Title (HN/T1)\nContent' });
    assert.equal(new mod.D20Resolver().resolve(input).status, 'fired');
  });

  it('D21 fires when a2a needed and returns CC_MENTION', () => {
    const input = makeInput({
      mode: 'serial',
      a2aEnabled: true,
      nativeL0Injected: false,
    });
    const result = new mod.D21Resolver().resolve(input);
    assert.equal(result.status, 'fired');
    assert.equal(result.vars.CC_MENTION, '@lang');
  });

  it('D21 skips when native L0', () => {
    const input = makeInput({ mode: 'serial', a2aEnabled: true, nativeL0Injected: true });
    assert.equal(new mod.D21Resolver().resolve(input).status, 'skipped');
  });

  it('R1, R2, N1 always fire', () => {
    const input = makeInput();
    assert.equal(new mod.R1Resolver().resolve(input).status, 'fired');
    assert.equal(new mod.R2Resolver().resolve(input).status, 'fired');
    assert.equal(new mod.N1Resolver().resolve(input).status, 'fired');
  });
});
