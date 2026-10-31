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

function evaluateConventionGraphRule(trace) {
  return evaluateCapabilityWakeupTrace(trace, [
    {
      id: 'convention-graph-before-convention-surface-edit',
      capability: 'convention-graph-discovery',
      predicate: {
        type: 'file_change_then_capability',
        capability: 'convention-graph-discovery',
        includeGlobs: [
          'packages/mcp-server/src/tools/*.ts',
          'packages/mcp-server/src/server-toolsets.ts',
          'cat-cafe-skills/*/SKILL.md',
        ],
        evidenceWindow: 'pre_change',
      },
    },
  ]);
}

describe('Capability wakeup convention graph pre-edit evidence', () => {
  it('counts a matching code-consumers query from the invocation before the edit', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-query', { type: 'text', content: '先查 MCP tool consumers。' }),
        transcriptEvent(1, 'inv-edit', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-query',
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
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-query:exec_command']);
  });

  it('counts an older same-session code-consumers query before an intermediate planning invocation', () => {
    const base = 1_700_000_000_000;
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        {
          ...transcriptEvent(0, 'inv-query', { type: 'text', content: '先查 MCP tool consumers。' }),
          t: base,
        },
        {
          ...transcriptEvent(1, 'inv-plan', { type: 'text', content: '整理一下改动计划。' }),
          t: base + 1_000,
        },
        {
          ...transcriptEvent(2, 'inv-edit', {
            type: 'tool_use',
            toolName: 'edit',
            toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
          }),
          t: base + 2_000,
        },
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-query',
          toolName: 'exec_command',
          timestamp: base + 500,
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
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-query:exec_command']);
  });

  it('counts a same-invocation query before an absolute-path convention edit', () => {
    const base = 1_700_000_000_000;
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        { ...transcriptEvent(0, 'inv-edit', { type: 'text', content: '先查 MCP tool consumers。' }), t: base },
        {
          ...transcriptEvent(2, 'inv-edit', {
            type: 'tool_use',
            toolName: 'edit',
            toolInput: {
              file_path: '/tmp/cat-cafe/packages/mcp-server/src/tools/callback-tools.ts',
            },
          }),
          t: base + 2_000,
        },
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-edit',
          toolName: 'exec_command',
          timestamp: base + 1_000,
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
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-edit:exec_command']);
  });

  it('does not count an after-the-fact code-consumers query from the next invocation', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-edit', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
        transcriptEvent(1, 'inv-after', { type: 'text', content: '补查影响面。' }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-after',
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

  it('does not count a query for a different convention surface domain', () => {
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        transcriptEvent(0, 'inv-query', { type: 'text', content: '先查 skill consumers。' }),
        transcriptEvent(1, 'inv-edit', {
          type: 'tool_use',
          toolName: 'edit',
          toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
        }),
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-query',
          toolName: 'exec_command',
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain skill-manifest --kind skill',
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

  it('uses each convention domain first edit as the pre-change cutoff', () => {
    const base = 1_700_000_000_000;
    const trace = buildCapabilityTrace({
      sessionId: 'session-cap',
      threadId: 'thread-cap',
      catId: 'gpt52',
      transcriptEvents: [
        {
          ...transcriptEvent(0, 'inv-multi', { type: 'text', content: '先分 domain 查约定图。' }),
          t: base,
        },
        {
          ...transcriptEvent(10, 'inv-multi', {
            type: 'tool_use',
            toolName: 'edit',
            toolInput: { file_path: 'packages/mcp-server/src/tools/callback-tools.ts' },
          }),
          t: base + 10_000,
        },
        {
          ...transcriptEvent(50, 'inv-multi', {
            type: 'tool_use',
            toolName: 'edit',
            toolInput: { file_path: 'cat-cafe-skills/convention-graph-discovery/SKILL.md' },
          }),
          t: base + 50_000,
        },
      ],
      toolEvents: [
        toolEvent({
          invocationId: 'inv-multi',
          toolName: 'exec_command',
          timestamp: base + 5_000,
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain mcp-tool --kind mcp_tool',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('packages/mcp-server/src/tools/callback-tools.ts'),
          },
        }),
        toolEvent({
          invocationId: 'inv-multi',
          toolName: 'exec_command',
          timestamp: base + 20_000,
          summary: {
            command: 'pnpm convention-graph:code-consumers -- --repo . --domain skill-manifest --kind skill',
            exitCode: 0,
            stdout: freshCodeConsumersStdout('cat-cafe-skills/convention-graph-discovery/SKILL.md', 'skill-manifest'),
          },
        }),
      ],
    });

    const trials = evaluateConventionGraphRule(trace);

    assert.equal(trials.length, 1);
    assert.equal(trials[0].outcome, 'negative');
    assert.deepEqual(trials[0].usageEvidence, ['tool:inv-multi:exec_command']);
  });
});
