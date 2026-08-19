import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCapabilityTrace,
  evaluateCapabilityWakeupTrace,
} from '../../dist/infrastructure/harness-eval/capability-wakeup/eval-capability-wakeup-adapter.js';
import { toolEvent, transcriptEvent } from './capability-wakeup-test-helpers.js';

function freshCodeConsumersStdout(filePath, domainId = 'mcp-tool') {
  return freshCodeConsumersStdoutForTargets([filePath], domainId);
}

function freshCodeConsumersStdoutForTargets(filePaths, domainId = 'mcp-tool') {
  return JSON.stringify({
    targets: filePaths.map((filePath) => ({ id: `${domainId}:${filePath}`, domainId, filePath })),
    freshness: { stale: false },
  });
}

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

describe('Capability wakeup convention graph tool-use mapping', () => {
  it('counts convention graph CLI queries as convention-graph-discovery usage evidence', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-conv:exec_command']);
  });

  it('counts completed convention graph CLI queries as usage evidence when results are fresh', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-completed', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-completed',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            status: 'completed',
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-conv-completed:exec_command']);
  });

  it('does not create convention graph trials for unindexed nested tool files', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-nested-tool', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/nested/helper.ts' },
        }),
      ],
      toolEvents: [],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 0);
  });

  it('does not create convention graph trials for unindexed non-TS tool files', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-readme-tool', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/README.md' },
        }),
      ],
      toolEvents: [],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 0);
  });

  it('counts convention graph queries whose targets cover the changed MCP surface file', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-helper-target', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/publish-verdict-sop-source-refs.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-helper-target',
          toolName: 'exec_command',
          summary: {
            command:
              'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool --name cat_cafe_publish_verdict',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/publish-verdict-tool.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-conv-helper-target:exec_command']);
  });

  it('does not count convention graph usage that covers only one changed MCP surface', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-partial-surface', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
        transcriptEvent(1, 'inv-conv-partial-surface', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/scheduler-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-partial-surface',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'miss');
    assert.deepEqual(trials[0].usageEvidence, []);
  });

  it('counts convention graph usage split across all changed MCP surfaces', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-complete-surface', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
        transcriptEvent(1, 'inv-conv-complete-surface', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/scheduler-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-complete-surface',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          },
        }),
        toolEvent({
          invocationId: 'inv-conv-complete-surface',
          toolName: 'command_execution',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/scheduler-tools.ts'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, [
      'tool:inv-conv-complete-surface:exec_command',
      'tool:inv-conv-complete-surface:command_execution',
    ]);
  });

  it('normalizes wrapped command_execution results before scoring convention graph usage', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-conv-wrapped-result', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-conv-wrapped-result',
          toolName: 'command_execution',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            result: {
              status: 'success',
              exitCode: 0,
              stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
            },
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-conv-wrapped-result:command_execution']);
  });
});
