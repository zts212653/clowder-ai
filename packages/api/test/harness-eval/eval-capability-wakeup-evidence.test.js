import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

describe('Capability Wakeup Evidence', () => {
  it('counts Codex-format create_rich_block tool names as rich-messaging evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-rich', {
          type: 'text',
          content: ['这是第一段说明。', '- 要点一', '- 要点二', '```json', '{"ok":true}', '```'].join('\n'),
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-rich',
          toolName: 'mcp:cat-cafe/create_rich_block',
        }),
      ],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'rich-messaging-long-structured-text',
        capability: 'rich-messaging',
        predicate: {
          type: 'multi_msg_text_volume_threshold',
          capability: 'rich-messaging',
          minTokenCount: 8,
          minStructuredSignals: 2,
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-rich:mcp:cat-cafe/create_rich_block']);
  });

  it('does not count unscoped audit events as workspace usage for another trace', () => {
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
        transcriptEvent(1, 'inv-1', {
          type: 'text',
          content: '我改了 docs/plans/demo.md',
        }),
      ],
      toolEvents: [],
      auditEvents: [
        {
          id: 'audit-1',
          type: 'workspace_navigate',
          timestamp: 1700000000500,
          data: {
            worktreeId: 'other-wt',
            path: 'docs/plans/demo.md',
            action: 'open',
          },
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

    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it("does not count another cat's tool usage as evidence for this trace", () => {
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
          content: '我改了 docs/plans/demo.md',
        }),
      ],
      toolEvents: [
        {
          ...toolEvent({
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
          catId: 'opus47',
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('ignores same-thread tool events from another session when building invocation windows', () => {
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
        transcriptEvent(1, 'inv-3', {
          type: 'text',
          content: '我已经把 docs/plans/demo.md 打开给你看了。',
        }),
      ],
      toolEvents: [
        {
          ...toolEvent({
            invocationId: 'foreign-inv',
            toolName: 'command_execution',
            turnIndex: 1,
            timestamp: Date.now() - 500,
            summary: {
              command: 'curl -X POST http://localhost:3004/api/workspace/navigate -H "Content-Type: application/json"',
              exitCode: 0,
              ok: true,
              path: 'docs/plans/demo.md',
              action: 'reveal',
            },
          }),
          sessionId: 'other-session',
        },
        toolEvent({
          invocationId: 'inv-3',
          toolName: 'command_execution',
          turnIndex: 2,
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

    assert.deepEqual(
      trace.invocations.map((invocation) => invocation.invocationId),
      ['inv-1', 'inv-3'],
    );

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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-3:command_execution']);
  });

  it('accepts invocation-scoped tool events for the active cat', () => {
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
        {
          ...toolEvent({
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
          sessionId: 'inv-2',
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-2:command_execution']);
  });

  it('does not clear a workspace miss from a command string without a success signal', () => {
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
          content: '我尝试对 docs/plans/demo.md 执行 curl，但这里没有成功证据。',
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
            ok: false,
            path: 'docs/plans/demo.md',
            action: 'reveal',
          },
        }),
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('treats explicit denied preview responses as misses even when HTTP status looks successful', () => {
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
        transcriptEvent(1, 'inv-preview', {
          type: 'text',
          content: '我试着开 preview 了，但被拒绝了。',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-preview',
          toolName: 'command_execution',
          turnIndex: 1,
          summary: {
            command: 'curl -X POST http://localhost:3004/api/preview/auto-open -H "Content-Type: application/json"',
            exitCode: 0,
            statusCode: 200,
            allowed: false,
          },
        }),
      ],
      previewAvailability: [{ worktreeId: 'test-wt', hasLivePort: true, observedAt: Date.now() }],
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count knowledge-feed workspace audit events as file navigation usage', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      worktreeId: 'test-wt',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/plans/demo.md' },
        }),
        transcriptEvent(1, 'inv-2', {
          type: 'text',
          content: '我切去了知识流，不是打开 docs/plans/demo.md。',
        }),
      ],
      toolEvents: [],
      auditEvents: [
        {
          id: 'audit-knowledge',
          type: 'workspace_navigate',
          timestamp: Date.now(),
          threadId: 'thread-cap',
          data: {
            worktreeId: 'test-wt',
            path: '',
            action: 'knowledge-feed',
            catId: 'gpt52',
          },
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count workspace navigation to a different path as usage for this opportunity', () => {
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
          content: '我没有打开 docs/plans/demo.md，我打开了别的文件。',
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
            path: 'docs/other.md',
            action: 'reveal',
          },
        }),
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('matches absolute changed file paths against repo-relative include globs', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-1', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: '/workspace/cat-cafe/docs/plans/demo.md' },
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
  });

  it('fails closed for workspace command evidence when trace requires a worktree but the usage summary omits it', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      worktreeId: 'test-wt',
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('accepts workspace command evidence when the usage summary carries the matching worktreeId', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      worktreeId: 'test-wt',
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
            worktreeId: 'test-wt',
          },
        }),
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-2:command_execution']);
  });

  it('accepts browser-preview command evidence when the usage summary carries the matching worktreeId', () => {
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
        transcriptEvent(1, 'inv-preview', {
          type: 'text',
          content: '我已经把 preview 打开了。',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-preview',
          toolName: 'command_execution',
          turnIndex: 1,
          summary: {
            command: 'curl -X POST http://localhost:3004/api/preview/auto-open -H "Content-Type: application/json"',
            exitCode: 0,
            allowed: true,
            worktreeId: 'test-wt',
          },
        }),
      ],
    });

    const trials = evaluateCapabilityWakeupTrace(trace, [
      {
        id: 'browser-preview-after-web-change',
        capability: 'browser-preview',
        predicate: {
          type: 'file_change_then_capability',
          capability: 'browser-preview',
          includeGlobs: ['packages/web/**'],
        },
      },
    ]);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-preview:command_execution']);
  });
});
