import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyStep } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js';
import {
  classifyAntigravityStepEffect,
  isReadOnlyMcpTool,
  summarizeAntigravityStepEffects,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-step-effects.js';

describe('F201 classifyAntigravityStepEffect', () => {
  test('CODE_ACTION is fail-closed and blocks blind retry', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
    };

    const effect = classifyAntigravityStepEffect(step);
    assert.equal(effect.kind, 'side_effect_done');
    assert.equal(effect.blocksBlindRetry, true);
    assert.equal(effect.target, 'docs/example.md');

    const summary = summarizeAntigravityStepEffects([step]);
    assert.equal(summary.hasUnsafeSideEffect, true);
    assert.equal(summary.blocksBlindRetry, true);
    assert.equal(summary.effects.length, 1);
    assert.equal(summary.effects[0].target, 'docs/example.md');
  });

  test('CODE_ACTION terminal status is reflected in side-effect summary flags', () => {
    const doneSummary = summarizeAntigravityStepEffects([
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ]);
    assert.equal(doneSummary.hasCompletedSideEffect, true);
    assert.equal(doneSummary.hasFailedSideEffect, false);

    const failedSummary = summarizeAntigravityStepEffects([
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_FAILED',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ]);
    assert.equal(failedSummary.hasCompletedSideEffect, false);
    assert.equal(failedSummary.hasFailedSideEffect, true);
  });

  test('single-L CANCELED status is treated as a failed side effect', () => {
    const effect = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_CANCELED',
      metadata: { operation: 'write', path: 'docs/example.md' },
    });

    assert.equal(effect.kind, 'side_effect_failed');
    assert.equal(effect.failedSideEffect, true);

    const summary = summarizeAntigravityStepEffects([
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_CANCELED',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ]);
    assert.equal(summary.hasFailedSideEffect, true);
  });

  test('unknown step type defaults to side-effect capable instead of retry-safe', () => {
    const effect = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_JETSKI_ACTION',
      status: 'IN_PROGRESS',
    });

    assert.equal(effect.kind, 'unknown_side_effect_capable');
    assert.equal(effect.blocksBlindRetry, true);
  });

  test('GENERATE_IMAGE stays a UI checkpoint but is effect-classified as artifact side effect', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_GENERATE_IMAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      generateImage: { imageName: 'cat-nest', prompt: 'warm desk' },
    };

    assert.equal(classifyStep(step), 'checkpoint');
    const effect = classifyAntigravityStepEffect(step);
    assert.equal(effect.kind, 'side_effect_done');
    assert.equal(effect.effectType, 'artifact');
    assert.equal(effect.target, 'cat-nest');
    assert.equal(effect.blocksBlindRetry, true);
  });

  test('unknown MCP_TOOL is unsafe by default; reviewed read-only MCP tools are tool_read', () => {
    const unknown = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_DONE',
      toolResult: { toolName: 'cat_cafe_post_message', success: true, output: 'posted' },
    });
    assert.equal(unknown.kind, 'side_effect_done');
    assert.equal(unknown.blocksBlindRetry, true);

    const readOnly = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_DONE',
      toolResult: { toolName: 'cat_cafe_search_evidence', success: true, output: '[]' },
    });
    assert.equal(readOnly.kind, 'tool_read');
    assert.equal(readOnly.blocksBlindRetry, false);
  });

  test('GitHub pull request read tools are retry-safe MCP reads', () => {
    const readOnly = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_FAILED',
      toolResult: { toolName: 'pull_request_read', success: false, output: 'Error: 工具调用失败' },
    });

    assert.equal(readOnly.kind, 'tool_read');
    assert.equal(readOnly.effectType, 'mcp');
    assert.equal(readOnly.toolName, 'pull_request_read');
    assert.equal(readOnly.blocksBlindRetry, false);
    assert.equal(isReadOnlyMcpTool('github-mcp-server__pull_request_read'), true);
  });

  test('Antigravity 2.x call_mcp_tool wrapper is classified by its nested MCP tool name', () => {
    const effect = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          name: 'call_mcp_tool',
          argumentsJson: JSON.stringify({
            ServerName: 'cat-cafe-memory',
            ToolName: 'cat_cafe_list_session_chain',
            Arguments: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus' }),
          }),
        },
      },
      mcpTool: {
        serverName: 'cat-cafe-memory',
        toolCall: {
          name: 'cat_cafe_list_session_chain',
          argumentsJson: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus' }),
        },
      },
    });

    assert.equal(effect.kind, 'tool_read');
    assert.equal(effect.effectType, 'mcp');
    assert.equal(effect.toolName, 'cat_cafe_list_session_chain');
    assert.equal(effect.blocksBlindRetry, false);
  });

  test('persistent read-only MCP allowlist is present in the readonly server toolset', async () => {
    const { READONLY_ALLOWED_TOOLS } = await import('../../mcp-server/dist/server-toolsets.js');
    const persistentReadonlyTools = [
      'cat_cafe_get_rich_block_rules',
      'cat_cafe_list_session_chain',
      'cat_cafe_read_session_events',
      'cat_cafe_read_session_digest',
      'cat_cafe_read_invocation_detail',
      'cat_cafe_shell_exec',
      'signal_list_inbox',
      'signal_get_article',
      'signal_search',
      'signal_list_studies',
    ];

    for (const toolName of persistentReadonlyTools) {
      assert.equal(isReadOnlyMcpTool(toolName), true, `${toolName} must be retry-safe in Antigravity`);
      assert.equal(READONLY_ALLOWED_TOOLS.has(toolName), true, `${toolName} must be available in readonly MCP mode`);
    }
  });

  test('cat_cafe_shell_exec remains coupled to the readonly shell command policy', async () => {
    const { isReadOnlyShellCommand } = await import('../../mcp-server/dist/tools/shell-tools.js');

    assert.equal(isReadOnlyMcpTool('cat_cafe_shell_exec'), true);
    assert.equal(isReadOnlyShellCommand('git status --short'), true);
    assert.equal(isReadOnlyShellCommand('mkdir should-not-run'), false);
    assert.equal(isReadOnlyShellCommand('git diff --output=/tmp/patch.diff'), false);
  });

  test('reviewed Antigravity read tools are retry-safe tool_read steps', () => {
    const effect = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      status: 'CORTEX_STEP_STATUS_DONE',
      toolCall: { toolName: 'grep_search', input: '{"query":"F201"}' },
    });

    assert.equal(effect.kind, 'tool_read');
    assert.equal(effect.effectType, 'mcp');
    assert.equal(effect.blocksBlindRetry, false);
    assert.equal(effect.toolName, 'grep_search');
  });

  test('CHECKPOINT / EPHEMERAL / USER_INPUT do not affect retry safety', () => {
    const summary = summarizeAntigravityStepEffects([
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
      { type: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE', status: 'IN_PROGRESS' },
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
    ]);

    assert.equal(summary.hasUnsafeSideEffect, false);
    assert.equal(summary.hasCompletedSideEffect, false);
    assert.equal(summary.blocksBlindRetry, false);
  });

  test('CONVERSATION_HISTORY does not affect retry safety', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_CONVERSATION_HISTORY',
      status: 'CORTEX_STEP_STATUS_DONE',
    };

    const effect = classifyAntigravityStepEffect(step);
    assert.equal(effect.kind, 'none');
    assert.equal(effect.sideEffectCapable, false);
    assert.equal(effect.blocksBlindRetry, false);

    const summary = summarizeAntigravityStepEffects([step]);
    assert.equal(summary.hasUnsafeSideEffect, false);
    assert.equal(summary.hasCompletedSideEffect, false);
    assert.equal(summary.blocksBlindRetry, false);
    assert.equal(summary.effects.length, 0);

    const mixedSummary = summarizeAntigravityStepEffects([
      step,
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: 'CORTEX_STEP_STATUS_DONE',
        mcpTool: {
          serverName: 'cat-cafe-memory',
          toolCall: {
            name: 'cat_cafe_list_session_chain',
            argumentsJson: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus' }),
          },
        },
      },
    ]);
    assert.equal(mixedSummary.hasUnsafeSideEffect, false);
    assert.equal(mixedSummary.blocksBlindRetry, false);
    assert.equal(mixedSummary.effects.length, 0);
  });

  test('sed -n with in-place edit flag is not read-only', () => {
    for (const commandLine of [
      "sed -n 's/foo/bar/p' -i file.txt",
      "sed -n 's/foo/bar/p' -i.bak file.txt",
      "sed -n 's/foo/bar/p' --in-place=.bak file.txt",
    ]) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }
  });

  test('shell control operators force commands to unsafe classification', () => {
    for (const commandLine of ['ls;rm -rf tmp', 'git status|tee out.txt']) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }
  });

  test('find commands with mutating primaries are unsafe', () => {
    for (const commandLine of [
      'find . -delete',
      'find . -name "*.tmp" -exec rm {} +',
      'find . -name "*.tmp" -fprint0 out.txt',
    ]) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }
  });

  test('git diff commands with output files are unsafe', () => {
    for (const commandLine of ['git diff --output=/tmp/patch.diff', 'git diff --output patch.diff']) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }
  });

  test('read-only command prefixes require word boundaries', () => {
    for (const commandLine of ['lsyncd /tmp/source /tmp/target', 'pwdx 1234', 'git difftool --dir-diff']) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }

    for (const commandLine of ['ls -la', 'pwd -P', 'git diff --stat']) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'tool_read');
      assert.equal(effect.blocksBlindRetry, false);
    }
  });

  test('GitHub PR inspection commands are read-only shell commands', () => {
    for (const commandLine of [
      'gh pr view 1863 --json title,body,state,headRefName,baseRefName,files,reviews,comments,additions,deletions,changedFiles',
      'gh pr diff 1863 --name-only',
      'gh pr checks 1863',
    ]) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_FAILED',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'tool_read');
      assert.equal(effect.effectType, 'shell');
      assert.equal(effect.blocksBlindRetry, false);
    }
  });

  test('git branch commands are unsafe because they can mutate refs', () => {
    for (const commandLine of ['git branch -d feature/foo', 'git branch -m old-name new-name']) {
      const effect = classifyAntigravityStepEffect({
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        runCommand: { commandLine },
      });

      assert.equal(effect.kind, 'side_effect_pending');
      assert.equal(effect.blocksBlindRetry, true);
    }
  });

  test('RUN_COMMAND classifier reads CommandLine from metadata toolCall arguments', () => {
    const readOnly = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_read_only',
          name: 'run_command',
          argumentsJson: '{"CommandLine":"git log --oneline -5","Cwd":"/tmp","SafeToAutoRun":true}',
        },
      },
    });
    assert.equal(readOnly.kind, 'tool_read');
    assert.equal(readOnly.blocksBlindRetry, false);

    const mutating = classifyAntigravityStepEffect({
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_mutating',
          name: 'run_command',
          argumentsJson: '{"CommandLine":"touch tmp/example","Cwd":"/tmp","SafeToAutoRun":true}',
        },
      },
    });
    assert.equal(mutating.kind, 'side_effect_pending');
    assert.equal(mutating.blocksBlindRetry, true);
  });

  test('UI bucket checkpoint does not imply retry-safe effect classification', () => {
    const fixtures = [
      {
        step: { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
        uiBucket: 'checkpoint',
        effectKind: 'none',
      },
      {
        step: { type: 'CORTEX_STEP_TYPE_GENERATE_IMAGE', status: 'CORTEX_STEP_STATUS_DONE' },
        uiBucket: 'checkpoint',
        effectKind: 'side_effect_done',
      },
      {
        step: { type: 'CORTEX_STEP_TYPE_CODE_ACTION', status: 'CORTEX_STEP_STATUS_DONE' },
        uiBucket: 'tool_pending',
        effectKind: 'side_effect_done',
      },
    ];

    for (const fixture of fixtures) {
      assert.equal(classifyStep(fixture.step), fixture.uiBucket);
      assert.equal(classifyAntigravityStepEffect(fixture.step).kind, fixture.effectKind);
    }
  });
});
