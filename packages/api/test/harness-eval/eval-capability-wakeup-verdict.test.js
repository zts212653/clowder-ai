import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  buildCapabilityWakeupVerdictHandoff,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { domain, toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

describe('Capability Wakeup Predicates And Verdicts', () => {
  it('supports text_pattern_then_capability and scenario_then_capability predicates', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'text',
          content: 'show me the options in a nicer format',
        }),
      ],
      toolEvents: [],
      previewAvailability: [{ worktreeId: 'test-wt', hasLivePort: false }],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-text-trigger',
        capability: 'rich-messaging',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'rich-messaging',
          patterns: ['show me', 'nicer format'],
        },
      },
      {
        id: 'preview-live-port',
        capability: 'browser-preview',
        predicate: {
          type: 'scenario_then_capability_predicate',
          capability: 'browser-preview',
          scenarioKey: 'preview_live_port',
        },
      },
    ]);

    assert.equal(trials.length, 2);
    assert.equal(trials[0].outcome, 'miss');
    assert.equal(trials[1].outcome, 'false_positive');
  });

  it('does not backfill a text-pattern opportunity from the next invocation', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'text',
          content: '先随便说一句，没有 trigger。',
        }),
        transcriptEvent(1, 'inv-2', {
          type: 'text',
          content: 'show me the options in a nicer format',
        }),
      ],
      toolEvents: [],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-text-trigger',
        capability: 'rich-messaging',
        predicate: {
          type: 'text_pattern_then_capability',
          capability: 'rich-messaging',
          patterns: ['show me', 'nicer format'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].window.currentInvocationId, 'inv-2');
  });

  it('scopes preview_live_port scenario detections to each invocation window', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      worktreeId: 'test-wt',
      transcriptEvents: [
        {
          v: 1,
          t: 1000,
          threadId: 'thread-cap',
          catId: 'gpt52',
          sessionId: 'session-cap',
          cliSessionId: 'cli-cap',
          invocationId: 'inv-1',
          eventNo: 0,
          event: {
            type: 'text',
            content: 'first turn without preview',
          },
        },
        {
          v: 1,
          t: 2000,
          threadId: 'thread-cap',
          catId: 'gpt52',
          sessionId: 'session-cap',
          cliSessionId: 'cli-cap',
          invocationId: 'inv-2',
          eventNo: 1,
          event: {
            type: 'text',
            content: 'second turn after preview came up',
          },
        },
      ],
      toolEvents: [],
      previewAvailability: [
        {
          worktreeId: 'test-wt',
          hasLivePort: true,
          observedAt: 2000,
        },
      ],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'preview-live-port',
        capability: 'browser-preview',
        predicate: {
          type: 'scenario_then_capability_predicate',
          capability: 'browser-preview',
          scenarioKey: 'preview_live_port',
        },
      },
    ]);

    assert.equal(trials.length, 2);
    assert.equal(trials[0].window.currentInvocationId, 'inv-1');
    assert.equal(trials[0].outcome, 'false_positive');
    assert.equal(trials[1].window.currentInvocationId, 'inv-2');
    assert.equal(trials[1].outcome, 'miss');
  });

  it('builds a verdict packet with dominant root cause mapping', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'text',
          content: '- one\n- two\n- three\n```md\nhello\n```\n| a | b |\n| - | - |\n| 1 | 2 |',
        }),
      ],
      toolEvents: [],
    });
    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-messaging-long-structured-text',
        capability: 'rich-messaging',
        predicate: {
          type: 'multi_msg_text_volume_threshold',
          capability: 'rich-messaging',
          minTokenCount: 10,
          minStructuredSignals: 3,
        },
      },
    ]);
    const classified = classifyCapabilityWakeupTrials(trace, trials);
    const packet = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'rich-messaging',
      trials: classified,
    });

    assert.equal(packet.domainId, 'eval:capability-wakeup');
    assert.equal(packet.harnessUnderEval.featureId, 'F203');
    assert.equal(packet.harnessUnderEval.componentId, 'rich-messaging');
    assert.equal(packet.verdict, 'fix');
    assert.match(packet.ownerAsk.requestedAction, /how-to|rich-messaging/i);
  });

  it('builds a keep_observe verdict when trials contain no misses', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/plans/demo.md' },
        }),
        transcriptEvent(1, 'inv-2', {
          type: 'text',
          content: '我已经把 docs/plans/demo.md 打开给你看了。',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-2',
          toolName: 'command_execution',
          turnIndex: 1,
          summary: {
            command: 'curl -X POST http://localhost:3004/api/workspace/navigate -H "Content-Type: application/json"',
            exitCode: 0,
            ok: true,
            path: 'docs/plans/demo.md',
            action: 'reveal',
          },
        }),
      ],
    });
    const trials = classifyCapabilityWakeupTrials(
      trace,
      evaluateCapabilityWakeupTrace(trace, [
        {
          id: 'workspace-open-after-file-change',
          capability: 'workspace-navigator',
          predicate: {
            type: 'file_change_then_capability',
            capability: 'workspace-navigator',
            includeGlobs: ['docs/**'],
            requirePathMention: true,
          },
        },
      ]),
    );

    const packet = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'workspace-navigator',
      trials,
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.match(packet.rootCauseHypothesis.summary, /No current evidence/i);
    assert.deepEqual(packet.rootCauseHypothesis.alternatives, [
      'Current window contains only successful or false-positive trials.',
    ]);
    assert.equal(packet.ownerAsk.requestedAction, 'No action required; keep observing the next scheduled eval.');
  });

  it('requires operator approval when a behavioral miss maps to a build verdict', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', { type: 'text', content: '先发一张卡片。' }),
        transcriptEvent(1, 'inv-2', {
          type: 'text',
          content: '- one\n- two\n- three\n```md\nhello\n```\n| a | b |\n| - | - |\n| 1 | 2 |',
        }),
      ],
      toolEvents: [toolEvent({ invocationId: 'inv-1', toolName: 'create_rich_block', turnIndex: 0, summary: {} })],
    });

    const trials = classifyCapabilityWakeupTrials(
      trace,
      evaluateCapabilityWakeupTrace(trace, [
        {
          id: 'rich-messaging-long-structured-text',
          capability: 'rich-messaging',
          predicate: {
            type: 'multi_msg_text_volume_threshold',
            capability: 'rich-messaging',
            minTokenCount: 10,
            minStructuredSignals: 3,
          },
        },
      ]),
    );

    const packet = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'rich-messaging',
      trials,
    });

    assert.equal(packet.verdict, 'build');
    assert.equal(packet.governance?.cvoAcceptRequired, true);
  });

  it('reports 0/0 opportunities when only false positives were observed', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      worktreeId: 'test-wt',
      transcriptEvents: [
        transcriptEvent(0, 'inv-web', {
          type: 'tool_use',
          toolName: 'Edit',
          toolInput: { file_path: 'packages/web/src/App.tsx' },
        }),
      ],
      toolEvents: [],
      previewAvailability: [{ worktreeId: 'test-wt', hasLivePort: false }],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'browser-preview-after-web-change',
        capability: 'browser-preview',
        predicate: {
          type: 'file_change_then_capability',
          capability: 'browser-preview',
          includeGlobs: ['packages/web/**'],
          requireLivePreview: true,
        },
      },
    ]);
    const classified = classifyCapabilityWakeupTrials(trace, trials);
    const packet = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'browser-preview',
      trials: classified,
    });

    assert.equal(packet.verdict, 'keep_observe');
    assert.match(packet.phenomenon, /\(0\/0\)$/);
  });

  it('preserves a caller-provided createdAt when building a verdict packet', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'text',
          content: '- one\n- two\n- three\n```md\nhello\n```\n| a | b |\n| - | - |\n| 1 | 2 |',
        }),
      ],
      toolEvents: [],
    });
    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-messaging-long-structured-text',
        capability: 'rich-messaging',
        predicate: {
          type: 'multi_msg_text_volume_threshold',
          capability: 'rich-messaging',
          minTokenCount: 10,
          minStructuredSignals: 3,
        },
      },
    ]);
    const classified = classifyCapabilityWakeupTrials(trace, trials);
    const packet = buildCapabilityWakeupVerdictHandoff({
      domain,
      capability: 'rich-messaging',
      trials: classified,
      createdAt: '2026-05-29T05:30:00.000Z',
    });

    assert.equal(packet.createdAt, '2026-05-29T05:30:00.000Z');
  });
});
