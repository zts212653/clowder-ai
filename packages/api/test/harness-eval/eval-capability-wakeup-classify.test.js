import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  classifyCapabilityWakeupTrials,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

describe('Capability Wakeup Classification', () => {
  it('detects rich-messaging miss from multi-message text volume threshold and classifies as cognitive without how-to proof', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-rich', {
          type: 'text',
          content:
            '- 方案 A：先做接口\n- 方案 B：补缓存层\n- 方案 C：写迁移脚本\n```ts\nconsole.log("diff")\n```\n| col | value |\n| --- | --- |\n| x | y |',
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
          minTokenCount: 20,
          minStructuredSignals: 3,
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');

    const classified = classifyCapabilityWakeupTrials(trace, trials);
    assert.equal(classified[0].label, 'cognitive');
  });

  it('classifies explicit reachability doubt as reachability_doubt', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-doubt', {
          type: 'text',
          content: '我没有这个工具吧？terminal 里调不了 workspace-navigator。',
        }),
        transcriptEvent(1, 'inv-doubt', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/notes/doubt.md' },
        }),
      ],
      toolEvents: [],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'workspace-open-after-file-change',
        capability: 'workspace-navigator',
        predicate: {
          type: 'file_change_then_capability',
          capability: 'workspace-navigator',
          includeGlobs: ['docs/**'],
          requirePathMention: false,
        },
      },
    ]);

    const classified = classifyCapabilityWakeupTrials(trace, trials);
    assert.equal(classified[0].label, 'reachability_doubt');
  });

  it('classifies later rich-messaging miss as behavioral when same session already demonstrated use', () => {
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

    const misses = trials.filter((trial) => trial.outcome === 'miss');
    assert.equal(misses.length, 1);

    const classified = classifyCapabilityWakeupTrials(trace, trials);
    const miss = classified.find((trial) => trial.outcome === 'miss');
    assert.equal(miss?.label, 'behavioral');
  });

  it('classifies workspace miss as attention_dilution when how-to was loaded and later forgotten', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-load', {
          type: 'tool_use',
          toolName: 'Read',
          toolInput: { file_path: 'cat-cafe-skills/workspace-navigator/SKILL.md' },
        }),
        transcriptEvent(1, 'inv-work', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/notes/demo.md' },
        }),
        transcriptEvent(2, 'inv-work', {
          type: 'text',
          content: '我改了 docs/notes/demo.md。顺便继续查别的 telemetry 和 scheduler 细节。',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-load',
          toolName: 'Read',
          turnIndex: 0,
          summary: { file_path: 'cat-cafe-skills/workspace-navigator/SKILL.md' },
        }),
        toolEvent({
          invocationId: 'inv-work',
          toolName: 'search_evidence',
          turnIndex: 2,
          summary: { query: 'telemetry' },
        }),
        toolEvent({ invocationId: 'inv-work', toolName: 'graph_resolve', turnIndex: 3, summary: { anchor: 'F192' } }),
      ],
      skillLoadEvents: [
        {
          invocationId: 'inv-load',
          sessionId: 'session-cap',
          skillId: 'workspace-navigator',
          loadTrigger: 'explicit_call',
          timestamp: Date.now(),
        },
      ],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
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
    ]);

    const classified = classifyCapabilityWakeupTrials(trace, trials);
    assert.equal(classified[0].label, 'attention_dilution');
  });

  it('leaves residual misses unclassified when how-to exists but no amplifier is present', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-load', {
          type: 'tool_use',
          toolName: 'Read',
          toolInput: { file_path: 'cat-cafe-skills/rich-messaging/SKILL.md' },
        }),
        transcriptEvent(1, 'inv-miss', {
          type: 'text',
          content: '- one\n- two\n- three\n```md\nhello\n```\n| a | b |\n| - | - |\n| 1 | 2 |',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-load',
          toolName: 'Read',
          turnIndex: 0,
          summary: { file_path: 'cat-cafe-skills/rich-messaging/SKILL.md' },
        }),
      ],
      skillLoadEvents: [
        {
          invocationId: 'inv-load',
          sessionId: 'session-cap',
          skillId: 'rich-messaging',
          loadTrigger: 'explicit_call',
          timestamp: Date.now(),
        },
      ],
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
    assert.equal(classified[0].label, 'unclassified');
  });
});
