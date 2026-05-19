import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyStep } from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js';
import {
  classifyAntigravityStepEffect,
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
