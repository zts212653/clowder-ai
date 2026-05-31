import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

describe('Capability Wakeup Trace', () => {
  it('builds invocation windows and carries next-invocation usage for workspace-navigator', () => {
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
          timestamp: Date.now() + 10_000,
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

    assert.equal(trace.invocations.length, 2);
    assert.deepEqual(trace.invocations[0].changedFiles, ['docs/plans/demo.md']);

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
    assert.equal(trials[0].window.currentInvocationId, 'inv-1');
    assert.equal(trials[0].window.nextInvocationId, 'inv-2');
  });

  it('filters transcript events to the requested cat and session before building windows', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        {
          ...transcriptEvent(0, 'foreign-inv', {
            type: 'tool_use',
            toolName: 'Write',
            toolInput: { file_path: 'docs/foreign.md' },
          }),
          catId: 'opus47',
        },
        {
          ...transcriptEvent(1, 'foreign-sess', {
            type: 'text',
            content: 'foreign session text',
          }),
          sessionId: 'other-session',
        },
        transcriptEvent(2, 'inv-1', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/plans/demo.md' },
        }),
        transcriptEvent(3, 'inv-2', {
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

    assert.equal(trace.invocations.length, 2);
    assert.deepEqual([...trace.invocations.map((invocation) => invocation.invocationId)].sort(), ['inv-1', 'inv-2']);
    assert.deepEqual(
      [...new Set(trace.invocations.flatMap((invocation) => invocation.changedFiles))],
      ['docs/plans/demo.md'],
    );
  });

  it('supports raw transcript tool_use fields (name/input) when building changedFiles', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(3, 'inv-raw', {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: 'docs/raw-shape.md' },
        }),
        transcriptEvent(4, 'inv-raw', {
          type: 'text',
          content: 'docs/raw-shape.md',
        }),
      ],
      toolEvents: [],
    });

    assert.deepEqual(trace.invocations[0].changedFiles, ['docs/raw-shape.md']);

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
  });

  it('extracts changedFiles from file_change changes arrays when paths are listed there', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(5, 'inv-file-change', {
          type: 'tool_use',
          toolName: 'file_change',
          toolInput: {
            status: 'completed',
            changes: ['packages/web/src/App.tsx', { path: 'packages/web/src/lib.ts' }],
          },
        }),
      ],
      toolEvents: [],
    });

    assert.deepEqual(trace.invocations[0].changedFiles, ['packages/web/src/App.tsx', 'packages/web/src/lib.ts']);
  });

  it('preserves transcript eventNo span when later tool events are merged into the same invocation', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(10, 'inv-gap', {
          type: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'docs/plans/demo.md' },
        }),
        transcriptEvent(11, 'inv-gap', {
          type: 'text',
          content: 'docs/plans/demo.md',
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-gap',
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

    assert.equal(trials[0].eventNoSpan.start, 10);
    assert.equal(trials[0].eventNoSpan.end, 11);
  });

  it('marks browser-preview as false_positive when packages/web changed but no live preview exists', () => {
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

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'false_positive');
  });

  it('counts live preview only when it belongs to the same worktree', () => {
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
      previewAvailability: [{ worktreeId: 'other-wt', hasLivePort: true, observedAt: Date.now() }],
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
    assert.equal(trials[0].outcome, 'false_positive');
  });

  it('counts live preview only when it was observed inside the opportunity window', () => {
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
      previewAvailability: [{ worktreeId: 'test-wt', hasLivePort: true, observedAt: Date.now() + 60_000 }],
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
    assert.equal(trials[0].outcome, 'false_positive');
  });

  it('treats matching live preview evidence inside the window as a real browser-preview opportunity', () => {
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
  });
});
