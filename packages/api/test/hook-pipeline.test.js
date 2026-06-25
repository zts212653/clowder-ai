/**
 * F237 Phase 2-C: HookPipeline execution engine tests
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

describe('HookPipeline', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookPipeline.js')} */
  let pipelineMod;

  it('load module', async () => {
    pipelineMod = await import('../dist/domains/prompt-hooks/HookPipeline.js');
  });

  it('hashContent produces consistent 16-char hex', () => {
    const h1 = pipelineMod.hashContent('hello world');
    const h2 = pipelineMod.hashContent('hello world');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.match(h1, /^[0-9a-f]{16}$/);
  });

  it('estimateTokens estimates ~4 chars per token', () => {
    assert.equal(pipelineMod.estimateTokens('abcd'), 1);
    assert.equal(pipelineMod.estimateTokens('abcde'), 2); // ceil(5/4)
    assert.equal(pipelineMod.estimateTokens(''), 0);
  });

  it('executeStage fires hooks in order with trace events', () => {
    // Mock registry with 2 hooks
    const mockRegistry = {
      getStageHooks: (stage) => {
        if (stage !== 'per-turn') return [];
        return [
          {
            manifest: { id: 'D1', stage: 'per-turn', order: 100, version: 1, enabled: true, template: 't.md' },
            dirPath: '/tmp/d1',
            templatePath: '/tmp/d1/t.md',
          },
          {
            manifest: { id: 'D2', stage: 'per-turn', order: 200, version: 1, enabled: true, template: 't.md' },
            dirPath: '/tmp/d2',
            templatePath: '/tmp/d2/t.md',
          },
        ];
      },
    };

    // Mock resolvers
    const resolvers = new Map();
    resolvers.set('D1', { resolve: () => ({ status: 'fired', vars: { NAME: 'test' } }) });
    resolvers.set('D2', { resolve: () => ({ status: 'skipped', reasonCode: 'no_dm', reason: 'No DM' }) });

    // Mock renderer
    const renderer = (id, vars) => `[${id}] name=${vars.NAME ?? ''}`;

    const pipeline = new pipelineMod.HookPipeline(mockRegistry, resolvers, renderer);
    const result = pipeline.executeStage('per-turn', makeInput());

    // D1 should fire, D2 should skip
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0].hookId, 'D1');
    assert.ok(result.patches[0].content.includes('name=test'));
    assert.equal(result.patches[0].order, 100);

    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].status, 'fired');
    assert.equal(result.events[0].hookId, 'D1');
    assert.ok(/** @type {any} */ (result.events[0]).contentHash);
    assert.equal(result.events[1].status, 'skipped');
    assert.equal(result.events[1].hookId, 'D2');
    assert.equal(/** @type {any} */ (result.events[1]).reasonCode, 'no_dm');
  });

  it('disabled hooks produce TraceEventDisabled', () => {
    const mockRegistry = {
      getStageHooks: () => [
        {
          manifest: { id: 'X1', stage: 'session-init', order: 100, version: 1, enabled: false, template: 't.md' },
          dirPath: '/tmp/x1',
          templatePath: '/tmp/x1/t.md',
        },
      ],
    };
    const pipeline = new pipelineMod.HookPipeline(mockRegistry, new Map(), () => 'content');
    const result = pipeline.executeStage('session-init', makeInput());

    assert.equal(result.patches.length, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].status, 'disabled');
    assert.equal(/** @type {any} */ (result.events[0]).disabledBy, 'manifest');
  });

  it('TEMPLATE_VARIANT resolves to variant template', () => {
    const mockRegistry = {
      getStageHooks: () => [
        {
          manifest: { id: 'D7', stage: 'per-turn', order: 700, version: 1, enabled: true, template: 't.md' },
          dirPath: '/tmp/d7',
          templatePath: '/tmp/d7/t.md',
        },
      ],
    };
    const resolvers = new Map();
    resolvers.set('D7', {
      resolve: () => ({ status: 'fired', vars: { TEMPLATE_VARIANT: 'D7_serial', CHAIN_INDEX: '2', CHAIN_TOTAL: '3' } }),
    });

    const renderedIds = [];
    const renderer = (id, vars) => {
      renderedIds.push(id);
      return `mode=${id} idx=${vars.CHAIN_INDEX}`;
    };

    const pipeline = new pipelineMod.HookPipeline(mockRegistry, resolvers, renderer);
    const result = pipeline.executeStage('per-turn', makeInput());

    // Renderer should be called with 'D7_serial', not 'D7'
    assert.deepEqual(renderedIds, ['D7_serial']);
    assert.equal(result.patches[0].hookId, 'D7'); // patch.hookId is still D7
    assert.ok(result.patches[0].content.includes('idx=2'));
  });

  it('missing template produces skipped event', () => {
    const mockRegistry = {
      getStageHooks: () => [
        {
          manifest: { id: 'X1', stage: 'per-turn', order: 100, version: 1, enabled: true, template: 't.md' },
          dirPath: '/tmp/x1',
          templatePath: '/tmp/x1/t.md',
        },
      ],
    };
    const resolvers = new Map();
    resolvers.set('X1', { resolve: () => ({ status: 'fired', vars: {} }) });
    // Renderer returns null = template missing
    const renderer = () => null;

    const pipeline = new pipelineMod.HookPipeline(mockRegistry, resolvers, renderer);
    const result = pipeline.executeStage('per-turn', makeInput());

    assert.equal(result.patches.length, 0);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].status, 'skipped');
    assert.equal(/** @type {any} */ (result.events[0]).reasonCode, 'template_missing');
  });

  it('hooks without resolver always fire', () => {
    const mockRegistry = {
      getStageHooks: () => [
        {
          manifest: { id: 'L1', stage: 'session-init', order: 100, version: 1, enabled: true, template: 't.md' },
          dirPath: '/tmp/l1',
          templatePath: '/tmp/l1/t.md',
        },
      ],
    };
    // No resolver for L1
    const renderer = () => 'governance content';
    const pipeline = new pipelineMod.HookPipeline(mockRegistry, new Map(), renderer);
    const result = pipeline.executeStage('session-init', makeInput());

    assert.equal(result.patches.length, 1);
    assert.equal(result.events[0].status, 'fired');
  });

  it('assemblePatches joins with double newline', () => {
    const patches = [
      { hookId: 'S1', content: 'identity block', order: 100 },
      { hookId: 'S2', content: 'restrictions', order: 200 },
    ];
    const assembled = pipelineMod.HookPipeline.assemblePatches(patches);
    assert.equal(assembled, 'identity block\n\nrestrictions');
  });

  it('empty stage produces no patches or events', () => {
    const mockRegistry = { getStageHooks: () => [] };
    const pipeline = new pipelineMod.HookPipeline(mockRegistry, new Map(), () => 'x');
    const result = pipeline.executeStage('session-init', makeInput());

    assert.equal(result.patches.length, 0);
    assert.equal(result.events.length, 0);
  });
});
