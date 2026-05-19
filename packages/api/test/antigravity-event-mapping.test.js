import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyStep,
  transformTrajectorySteps,
} from '../dist/domains/cats/services/agents/providers/antigravity/antigravity-event-transformer.js';

const catId = 'antigravity';
const metadata = { provider: 'antigravity', model: 'gemini-3.1-pro' };

// ── Bug-4: Step taxonomy v2 — silent skip + shape-based fallback ──

describe('classifyStep: USER_INPUT / empty PLANNER_RESPONSE → checkpoint', () => {
  test('USER_INPUT → checkpoint (silently skipped)', () => {
    const step = { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' };
    assert.equal(classifyStep(step), 'checkpoint');
  });

  test('PLANNER_RESPONSE with no plannerResponse → checkpoint', () => {
    const step = { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' };
    assert.equal(classifyStep(step), 'checkpoint');
  });

  test('PLANNER_RESPONSE with empty plannerResponse → checkpoint', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {},
    };
    assert.equal(classifyStep(step), 'checkpoint');
  });
});

describe('classifyStep: native tool types via shape-based fallback', () => {
  test('GREP_SEARCH with toolCall → tool_pending', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      status: 'CORTEX_STEP_STATUS_WAITING',
      toolCall: { toolName: 'grep_search', input: '{"query":"foo"}' },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });

  test('FILE_EDIT with toolResult success → tool_pending', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_FILE_EDIT',
      status: 'FINISHED',
      toolResult: { toolName: 'file_edit', success: true, output: 'done' },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });

  test('TERMINAL_COMMAND with toolResult failure → tool_error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_TERMINAL_COMMAND',
      status: 'FINISHED',
      toolResult: { toolName: 'terminal', success: false, error: 'exit 1' },
    };
    assert.equal(classifyStep(step), 'tool_error');
  });

  test('unknown type without toolCall/toolResult → unknown_activity', () => {
    const step = { type: 'CORTEX_STEP_TYPE_JETSKI_ACTION', status: 'IN_PROGRESS' };
    assert.equal(classifyStep(step), 'unknown_activity');
  });

  test('CODE_ACTION → tool_pending instead of unknown_activity', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });
});

describe('transformer: USER_INPUT and empty PLANNER_RESPONSE emit nothing', () => {
  test('USER_INPUT emits no messages', () => {
    const steps = [{ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' }];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'USER_INPUT should produce no output');
  });

  test('empty PLANNER_RESPONSE emits no messages', () => {
    const steps = [
      { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: {} },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'empty PLANNER_RESPONSE should produce no output');
  });

  test('unknown step type without data emits no messages (no JSON leak)', () => {
    const steps = [{ type: 'CORTEX_STEP_TYPE_JETSKI_ACTION', status: 'IN_PROGRESS' }];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'unknown step without data should not leak JSON');
  });

  test('CODE_ACTION emits structured side-effect activity metadata', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const activity = msgs.find((m) => m.type === 'system_info');
    assert.ok(activity, 'CODE_ACTION should no longer be silently skipped as unknown_activity');
    assert.deepEqual(JSON.parse(activity.content), {
      type: 'code_action',
      status: 'CORTEX_STEP_STATUS_DONE',
      operation: 'write',
      path: 'docs/example.md',
    });
  });

  test('failed CODE_ACTION without toolResult emits a visible error', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_FAILED',
        metadata: { operation: 'write', path: 'docs/example.md' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'failed CODE_ACTION should not be silently skipped');
    assert.equal(error.errorCode, 'code_action_error');
    assert.match(error.error, /Code action failed/);
    assert.match(error.error, /write/);
    assert.match(error.error, /docs\/example\.md/);
  });

  test('canceled CODE_ACTION without toolResult emits a visible error', () => {
    for (const status of ['CORTEX_STEP_STATUS_CANCELED', 'CORTEX_STEP_STATUS_CANCELLED']) {
      const step = {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status,
        metadata: { operation: 'write', path: 'docs/example.md' },
      };

      assert.equal(classifyStep(step), 'tool_error');

      const msgs = transformTrajectorySteps([step], catId, metadata);
      const error = msgs.find((m) => m.type === 'error');
      assert.ok(error, 'canceled CODE_ACTION should not be emitted as normal activity');
      assert.equal(error.errorCode, 'code_action_error');
      assert.match(error.error, /Code action failed/);
      assert.match(error.error, new RegExp(status));
    }
  });

  test('CODE_ACTION with failed toolResult is classified and emitted as an error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { operation: 'write', path: 'docs/example.md' },
      toolResult: { toolName: 'code_action', success: false, error: 'permission denied' },
    };

    assert.equal(classifyStep(step), 'tool_error');

    const msgs = transformTrajectorySteps([step], catId, metadata);
    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'failed CODE_ACTION toolResult should not be emitted as a normal tool result');
    assert.equal(error.errorCode, 'tool_error');
    assert.match(error.error, /permission denied/);
  });
});

describe('transformer: native tool fallback emits tool messages', () => {
  test('GREP_SEARCH with toolCall emits tool_use', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
        status: 'IN_PROGRESS',
        toolCall: { toolName: 'grep_search', input: '{"query":"hello"}' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const toolMsg = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg, 'should emit tool_use for GREP_SEARCH');
    assert.equal(toolMsg.toolName, 'grep_search');
  });
});

// ── P2: MCP_TOOL / CHECKPOINT / EPHEMERAL_MESSAGE mapping ─────────

describe('classifyStep: MCP_TOOL / CHECKPOINT / EPHEMERAL_MESSAGE', () => {
  test('MCP_TOOL → tool_pending', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'IN_PROGRESS',
      toolCall: { toolName: 'read_file', input: '{"path":"src/index.ts"}' },
    };
    assert.equal(classifyStep(step), 'tool_pending');
  });

  test('MCP_TOOL with failed toolResult → tool_error', () => {
    const step = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'FINISHED',
      toolResult: { toolName: 'write_file', success: false, error: 'permission denied' },
    };
    assert.equal(classifyStep(step), 'tool_error');
  });

  test('CHECKPOINT → checkpoint (silently skipped)', () => {
    const step = { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' };
    assert.equal(classifyStep(step), 'checkpoint');
  });

  test('EPHEMERAL_MESSAGE → checkpoint (silently skipped)', () => {
    const step = { type: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE', status: 'IN_PROGRESS' };
    assert.equal(classifyStep(step), 'checkpoint');
  });
});

describe('transformer: MCP_TOOL', () => {
  test('MCP_TOOL with toolCall emits tool_use', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: 'IN_PROGRESS',
        toolCall: { toolName: 'read_file', input: '{"path":"src/index.ts"}' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const toolMsg = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg, 'should emit tool_use for MCP_TOOL');
    assert.equal(toolMsg.toolName, 'read_file');
  });

  test('MCP_TOOL with toolResult emits tool_result', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: 'FINISHED',
        toolResult: { toolName: 'read_file', success: true, output: 'file contents here' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const resultMsg = msgs.find((m) => m.type === 'tool_result');
    assert.ok(resultMsg, 'should emit tool_result for MCP_TOOL');
    assert.equal(resultMsg.content, 'file contents here');
  });

  test('MCP_TOOL failure emits error', () => {
    const steps = [
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: 'FINISHED',
        toolResult: { toolName: 'write_file', success: false, error: 'permission denied' },
      },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const errMsg = msgs.find((m) => m.type === 'error');
    assert.ok(errMsg, 'should emit error for failed MCP_TOOL');
    assert.match(errMsg.error, /write_file.*permission denied/);
  });
});

describe('transformer: CHECKPOINT and EPHEMERAL_MESSAGE', () => {
  test('CHECKPOINT emits no messages', () => {
    const steps = [{ type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' }];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'checkpoint should produce no output');
  });

  test('EPHEMERAL_MESSAGE emits no messages', () => {
    const steps = [{ type: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE', status: 'IN_PROGRESS' }];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    assert.equal(msgs.length, 0, 'ephemeral message should produce no output');
  });

  test('CHECKPOINT mixed with real output does not leak JSON', () => {
    const steps = [
      { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: 'Hello!' },
      },
      { type: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE', status: 'IN_PROGRESS' },
    ];
    const msgs = transformTrajectorySteps(steps, catId, metadata);
    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1);
    assert.equal(textMsgs[0].content, 'Hello!');
    const unknowns = msgs.filter((m) => {
      if (m.type !== 'system_info') return false;
      const c = JSON.parse(m.content);
      return c.type === 'unknown_activity';
    });
    assert.equal(unknowns.length, 0, 'no unknown_activity should leak');
  });
});
