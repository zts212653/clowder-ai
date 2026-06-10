import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

describe('Capability wakeup Tier 1 tool-use mapping (AC-F7)', () => {
  it('counts create_rich_block as rich-messaging usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-rich', {
          type: 'text',
          content: '这个长结构化汇报应该用 rich block 展示。',
        }),
      ],
      toolEvents: [toolEvent({ invocationId: 'inv-rich', toolName: 'cat_cafe_create_rich_block' })],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-messaging-structured-output',
        capability: 'rich-messaging',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'rich-messaging',
          patterns: ['rich block|结构化汇报'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-rich:cat_cafe_create_rich_block']);
  });

  it('counts cat_cafe_publish_verdict as eval-verdict usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-eval', {
          type: 'text',
          content: '这个 harness 改动需要 eval hub verdict 闭环证据。',
        }),
      ],
      toolEvents: [toolEvent({ invocationId: 'inv-eval', toolName: 'cat_cafe_publish_verdict' })],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'eval-verdict-harness-closure',
        capability: 'eval-verdict',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'eval-verdict',
          patterns: ['eval hub|verdict|闭环证据'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-eval:cat_cafe_publish_verdict']);
  });

  it('counts actual guide-interaction tools as guide-interaction usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-guide', {
          type: 'text',
          content: '这个配置流程需要一步步引导用户完成。',
        }),
      ],
      toolEvents: [toolEvent({ invocationId: 'inv-guide', toolName: 'cat_cafe_start_guide' })],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'guide-interaction-how-to-request',
        capability: 'guide-interaction',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'guide-interaction',
          patterns: ['一步步|引导用户'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-guide:cat_cafe_start_guide']);
  });

  it('counts cat_cafe_run_perspective as expert-panel usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-panel', {
          type: 'text',
          content: '这个架构判断需要多视角专家讨论。',
        }),
      ],
      toolEvents: [toolEvent({ invocationId: 'inv-panel', toolName: 'cat_cafe_run_perspective' })],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'expert-panel-multi-perspective-request',
        capability: 'expert-panel',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'expert-panel',
          patterns: ['多视角|专家讨论'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-panel:cat_cafe_run_perspective']);
  });

  it('does not count failed direct MCP tool calls as successful usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-failed', {
          type: 'text',
          content: '这个 harness 改动需要 eval hub verdict 闭环证据。',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-failed',
          toolName: 'cat_cafe_publish_verdict',
          summary: { isError: true, errorMessage: 'Callback failed (404): no trials' },
        }),
      ],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'eval-verdict-harness-closure',
        capability: 'eval-verdict',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'eval-verdict',
          patterns: ['eval hub|verdict|闭环证据'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });
});
