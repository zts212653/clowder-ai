import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

function freshCodeConsumersStdout(filePath, domainId = 'mcp-tool') {
  return JSON.stringify({
    targets: [{ id: `${domainId}:${filePath}`, domainId, filePath }],
    freshness: { stale: false },
  });
}

const freshCodeConsumersWithoutTargetsStdout = JSON.stringify({ targets: [], freshness: { stale: false } });
const staleCodeConsumersStdout = JSON.stringify({
  freshness: { stale: true, pendingChanges: ['packages/mcp-server/src/tools/callback-tools.ts'] },
});

function evaluateConventionGraphRule(trace, includeGlobs = ['packages/mcp-server/src/tools/*.ts']) {
  return evaluateCapabilityWakeupTrace(trace, [
    {
      id: 'convention-graph-before-convention-surface-edit',
      capability: 'convention-graph-discovery',
      predicate: {
        type: 'file_change_then_capability',
        capability: 'convention-graph-discovery',
        includeGlobs,
      },
    },
  ]);
}

describe('Capability wakeup convention graph invalid tool-use evidence', () => {
  it('does not count stale convention graph CLI results as usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-stale', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-stale',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: staleCodeConsumersStdout,
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count convention graph index-only runs as impact lookup evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-index', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-index',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:index -- --repo .',
            exitCode: 0,
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count fresh convention graph CLI results with no matched targets', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-empty-targets', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-empty-targets',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name typo',
            exitCode: 0,
            stdout: freshCodeConsumersWithoutTargetsStdout,
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count fresh convention graph CLI results targeting a different convention surface', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-wrong-target', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-wrong-target',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name other',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/scheduler-tools.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count command-only graph queries without real result metadata', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-unknown', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-unknown',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('does not count convention graph queries when the result summary reports failure', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-error', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-error',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            isError: true,
            errorMessage: 'command failed: graph db not found',
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('marks convention-surface edits as misses when no convention graph query ran', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-miss', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'cat-cafe-skills/convention-graph-discovery/SKILL.md' },
        }),
      ],
      toolEvents: [],
    });

    const trials = evaluateConventionGraphRule(trace, ['cat-cafe-skills/*/SKILL.md']);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });
});
