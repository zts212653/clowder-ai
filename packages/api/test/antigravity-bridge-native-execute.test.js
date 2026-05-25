import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';
import { AuditLogger } from '../dist/domains/cats/services/agents/providers/antigravity/executors/AuditLogger.js';
import { ExecutorRegistry } from '../dist/domains/cats/services/agents/providers/antigravity/executors/ExecutorRegistry.js';
import { RunCommandExecutor } from '../dist/domains/cats/services/agents/providers/antigravity/executors/RunCommandExecutor.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeStep({
  status = 'CORTEX_STEP_STATUS_WAITING',
  commandLine = 'echo probe',
  stepIndex = 0,
  trajectoryId = 't1',
} = {}) {
  return {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status,
    metadata: {
      toolCall: {
        id: 'toolu_1',
        name: 'run_command',
        argumentsJson: JSON.stringify({ CommandLine: commandLine, Cwd: '/tmp', SafeToAutoRun: true }),
      },
      sourceTrajectoryStepInfo: { trajectoryId, stepIndex, cascadeId: 'c1' },
    },
  };
}

describe('AntigravityBridge.nativeExecuteAndPush', () => {
  const cleanupPaths = [];
  const cleanupDirs = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    for (const d of cleanupDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    cleanupPaths.length = 0;
    cleanupDirs.length = 0;
  });

  function makeBridge() {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({ stdout: 'probe\n', stderr: '', exitCode: 0 }));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);
    const registry = new ExecutorRegistry();
    const audit = new AuditLogger(logDir);
    registry.register(new RunCommandExecutor({ rpc: rpcMock }));
    bridge.attachExecutors(registry, audit);
    return { bridge, rpcMock, audit, logDir };
  }

  test('executes WAITING RUN_COMMAND step and pushes result', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'echo probe' });
    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });
    assert.equal(handled, true);
    // rpcMock receives both executor calls (2-arg: method, payload) and bridge calls
    // (3-arg: conn, method, payload). Extract method from whichever position is a string.
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.includes('RunCommand'), `expected RunCommand call, got ${methods.join(',')}`);
    assert.ok(methods.includes('CancelCascadeSteps'), `expected CancelCascadeSteps call, got ${methods.join(',')}`);
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    const [cascadeIdArg, textArg, modelArg] = bridge.sendMessage.mock.calls[0].arguments;
    assert.equal(cascadeIdArg, 'c1');
    assert.match(textArg, /\[native-executor result for: echo probe\]/);
    assert.equal(modelArg, 'claude-opus-4-6', 'tool-result writeback must preserve the requested model');
  });

  test('pre-approves run_command permission before invoking RunCommand unary', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'git log --oneline -5', stepIndex: 23, trajectoryId: 'traj-1' });

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    const approvalIdx = methods.indexOf('HandleCascadeUserInteraction');
    const runIdx = methods.indexOf('RunCommand');
    assert.notEqual(approvalIdx, -1, 'must call HandleCascadeUserInteraction to satisfy PermissionManager first');
    assert.notEqual(runIdx, -1, 'must still execute RunCommand');
    assert.ok(approvalIdx < runIdx, 'permission approval must happen before RunCommand unary');

    const approvalCall = rpcMock.mock.calls.find((c) => {
      const args = c.arguments;
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      return method === 'HandleCascadeUserInteraction';
    });
    assert.ok(approvalCall, 'approval call should be recorded');
    const payload =
      typeof approvalCall.arguments[0] === 'string' ? approvalCall.arguments[1] : approvalCall.arguments[2];
    assert.deepEqual(payload, {
      cascadeId: 'c1',
      interaction: {
        permission: { allow: true },
        trajectoryId: 'traj-1',
        stepIndex: 23,
      },
    });
  });

  test('permission guard RPC failure does not block RunCommand + pushToolResult fallback', async () => {
    const { bridge, logDir } = makeBridge();
    const rpcMock = mock.fn(async (...args) => {
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      if (method === 'HandleCascadeUserInteraction') {
        throw new Error('permission rpc unavailable');
      }
      return { stdout: 'probe\n', stderr: '', exitCode: 0 };
    });
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    const registry = new ExecutorRegistry();
    const audit = new AuditLogger(logDir);
    registry.register(new RunCommandExecutor({ rpc: rpcMock }));
    bridge.attachExecutors(registry, audit);

    const step = makeStep({ commandLine: 'git log --oneline -5', stepIndex: 23, trajectoryId: 'traj-1' });
    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true, 'permission guard should be best-effort, not a hard stop');
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.includes('HandleCascadeUserInteraction'));
    assert.ok(methods.includes('RunCommand'), 'must still execute RunCommand when permission hint fails');
    assert.ok(methods.includes('CancelCascadeSteps'), 'must still cancel stuck step before writeback');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'must still inject fallback result message');
  });

  test('refused commands are blocked before permission approval RPC', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'redis-cli -p 6399 flushall', stepIndex: 23, trajectoryId: 'traj-1' });

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true, 'bridge should treat refused command as handled without touching LS permission flow');
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(
      methods.includes('HandleCascadeUserInteraction'),
      false,
      'unsafe commands must not be permission-approved before local refusal logic runs',
    );
    assert.equal(methods.includes('RunCommand'), false, 'unsafe commands must not reach RunCommand unary');
    assert.ok(methods.includes('CancelCascadeSteps'), 'refused command should still cancel the waiting step');
    assert.equal(bridge.sendMessage.mock.callCount(), 1, 'refused command should still write back fallback result');
    const textArg = bridge.sendMessage.mock.calls[0].arguments[1];
    assert.match(textArg, /Redis 6399 is user sanctum/i);
  });

  test('skips non-WAITING steps', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ status: 'CORTEX_STEP_STATUS_DONE' });
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('returns no_executor for step types not in registry', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: { toolCall: { name: 'read_file', argumentsJson: '{}' } },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, 'no_executor', 'step with no matching executor must return no_executor (not false)');
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('routes LS-owned file write tools to approval_pending instead of native writeback', async () => {
    const lsOwnedTools = ['write_to_file', 'write_file', 'replace_file_content', 'multi_replace_file_content'];
    for (const toolName of lsOwnedTools) {
      const { bridge, rpcMock } = makeBridge();
      const step = {
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: {
            id: `toolu_${toolName}`,
            name: toolName,
            argumentsJson: JSON.stringify({ Path: 'src/index.ts', Content: 'unsafe' }),
          },
          sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 9, cascadeId: 'c1' },
        },
      };

      const handled = await bridge.nativeExecuteAndPush(step, {
        cascadeId: 'c1',
        cwd: '/tmp',
        modelName: 'claude-opus-4-6',
      });

      assert.equal(handled, 'approval_pending', `${toolName} must be approved by Antigravity LS, not executed here`);
      assert.equal(rpcMock.mock.callCount(), 0, `${toolName} must not call RunCommand or pushToolResult RPCs`);
      assert.equal(bridge.sendMessage.mock.callCount(), 0, `${toolName} must not synthetic-writeback a file result`);
    }
  });

  test('routes ask_permission waiting tool steps to approval_pending instead of native writeback', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_TOOL_CALL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_ask_permission',
          name: 'ask_permission',
          argumentsJson: JSON.stringify({ reason: 'Apply pending edit' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-ask', stepIndex: 13, cascadeId: 'c1' },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, 'approval_pending', 'ask_permission must be approved by Antigravity LS');
    assert.equal(rpcMock.mock.callCount(), 0, 'ask_permission must not call RunCommand or pushToolResult RPCs');
    assert.equal(bridge.sendMessage.mock.callCount(), 0, 'ask_permission must not synthetic-writeback a result');
  });

  test('approves CODE_ACTION write permissions through Antigravity user interaction RPC', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_write_to_file',
          name: 'write_to_file',
          argumentsJson: JSON.stringify({ Path: 'src/index.ts', Content: 'safe probe' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 9, cascadeId: 'c1' },
      },
      requestedInteraction: {
        permission: {
          resource: {
            action: 'write_file',
            target: '/tmp/src/index.ts',
          },
        },
      },
    };

    await bridge.approvePendingInteraction('c1', step);

    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.deepEqual(methods, ['HandleCascadeUserInteraction']);

    const payload = rpcMock.mock.calls[0].arguments[2];
    assert.deepEqual(payload, {
      cascadeId: 'c1',
      interaction: {
        permission: { allow: true },
        trajectoryId: 'traj-1',
        stepIndex: 9,
      },
    });
    assert.equal(bridge.sendMessage.mock.callCount(), 0, 'code action approval must not synthetic-writeback');
  });

  test('approves generic requestedInteraction permission steps through Antigravity user interaction RPC', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_TOOL_CALL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_ask_permission',
          name: 'ask_permission',
          argumentsJson: JSON.stringify({ reason: 'Apply pending edit' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-ask', stepIndex: 13, cascadeId: 'c1' },
      },
      requestedInteraction: {
        permission: {
          resource: {
            action: 'write_file',
            target: 'docs/probe.md',
          },
        },
      },
    };

    await bridge.approvePendingInteraction('c1', step);

    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.deepEqual(methods, ['HandleCascadeUserInteraction']);

    const payload = rpcMock.mock.calls[0].arguments[2];
    assert.deepEqual(payload, {
      cascadeId: 'c1',
      interaction: {
        permission: { allow: true },
        trajectoryId: 'traj-ask',
        stepIndex: 13,
      },
    });
    assert.equal(bridge.sendMessage.mock.callCount(), 0, 'permission approval must not synthetic-writeback');
  });

  test('acknowledges non-permission CODE_ACTION steps without requiring trajectoryId', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_code_action_ack',
          name: 'show_diff',
          argumentsJson: JSON.stringify({ Path: 'src/index.ts' }),
        },
        sourceTrajectoryStepInfo: { stepIndex: 4, cascadeId: 'c1' },
      },
    };

    await bridge.approvePendingInteraction('c1', step);

    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.deepEqual(methods, ['AcknowledgeCodeActionStep']);

    const payload = rpcMock.mock.calls[0].arguments[2];
    assert.deepEqual(payload, {
      cascadeId: 'c1',
      accept: true,
      stepIndices: [4],
    });
  });

  test('executes Antigravity 2.x call_mcp_tool wrapper using the nested MCP tool payload', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: { content: [{ type: 'text', text: 'ok' }] },
      stdout: 'ok',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'call_mcp_tool',
      canHandle: (step) => step.metadata?.toolCall?.name === 'call_mcp_tool',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_mcp',
          name: 'call_mcp_tool',
          argumentsJson: JSON.stringify({
            ServerName: 'cat-cafe-memory',
            ToolName: 'cat_cafe_list_session_chain',
            Arguments: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus', limit: 5 }),
          }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 3, cascadeId: 'c1' },
      },
      mcpTool: {
        serverName: 'cat-cafe-memory',
        toolCall: {
          name: 'cat_cafe_list_session_chain',
          argumentsJson: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus', limit: 5 }),
        },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    assert.equal(executeMock.mock.callCount(), 1);
    assert.deepEqual(executeMock.mock.calls[0].arguments[0], {
      serverName: 'cat-cafe-memory',
      toolName: 'cat_cafe_list_session_chain',
      arguments: { threadId: 'thread-1', catId: 'antig-opus', limit: 5 },
    });
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(
      methods.includes('HandleCascadeUserInteraction'),
      false,
      'MCP wrapper should not approve LS permission',
    );
    assert.ok(methods.includes('CancelCascadeSteps'), 'MCP result writeback must cancel the waiting step');
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    const textArg = bridge.sendMessage.mock.calls[0].arguments[1];
    assert.match(textArg, /\[native-executor result for: cat-cafe-memory\/cat_cafe_list_session_chain\]/);
    assert.match(textArg, /ok/);
  });

  test('executes Antigravity IDE read-only tools through their native executor', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: 'src/index.ts:1:needle',
      stdout: 'src/index.ts:1:needle',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'grep_search',
      canHandle: (step) => step.metadata?.toolCall?.name === 'grep_search',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_grep',
          name: 'grep_search',
          argumentsJson: JSON.stringify({ Pattern: 'needle', Path: 'src' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 7, cascadeId: 'c1' },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    assert.equal(executeMock.mock.callCount(), 1);
    assert.deepEqual(executeMock.mock.calls[0].arguments[0], { Pattern: 'needle', Path: 'src' });
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(
      methods.includes('HandleCascadeUserInteraction'),
      false,
      'read-only IDE tools should not approve LS permission',
    );
    assert.ok(methods.includes('CancelCascadeSteps'), 'read-only IDE result writeback must cancel the waiting step');
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    const textArg = bridge.sendMessage.mock.calls[0].arguments[1];
    assert.match(textArg, /\[native-executor result for: grep_search/);
    assert.match(textArg, /src\/index\.ts:1:needle/);
  });

  test('falls back to toolCall.input when IDE read tool metadata arguments are blank', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: 'src/index.ts:1:needle',
      stdout: 'src/index.ts:1:needle',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'grep_search',
      canHandle: (step) => step.metadata?.toolCall?.name === 'grep_search',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_grep',
          name: 'grep_search',
          argumentsJson: '',
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 7, cascadeId: 'c1' },
      },
      toolCall: {
        input: JSON.stringify({ Pattern: 'needle', Path: 'src' }),
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    assert.equal(executeMock.mock.callCount(), 1);
    assert.deepEqual(executeMock.mock.calls[0].arguments[0], { Pattern: 'needle', Path: 'src' });
  });

  test('refuses generic native writeback for non-read-only executors', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: 'wrote',
      stdout: 'wrote',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'delete_file',
      canHandle: (step) => step.metadata?.toolCall?.name === 'delete_file',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_DELETE_FILE',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_delete',
          name: 'delete_file',
          argumentsJson: JSON.stringify({ Path: 'src/index.ts' }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 8, cascadeId: 'c1' },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, 'no_executor');
    assert.equal(executeMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('falls back to wrapper MCP payload when nested MCP fields are empty strings', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: { content: [{ type: 'text', text: 'ok' }] },
      stdout: 'ok',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'call_mcp_tool',
      canHandle: (step) => step.metadata?.toolCall?.name === 'call_mcp_tool',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_mcp',
          name: 'call_mcp_tool',
          argumentsJson: JSON.stringify({
            ServerName: 'cat-cafe-memory',
            ToolName: 'cat_cafe_list_session_chain',
            Arguments: JSON.stringify({ threadId: 'thread-1', catId: 'antig-opus', limit: 5 }),
          }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 3, cascadeId: 'c1' },
      },
      mcpTool: {
        serverName: '',
        toolCall: {
          name: '',
          argumentsJson: '',
        },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    assert.equal(executeMock.mock.callCount(), 1);
    assert.deepEqual(executeMock.mock.calls[0].arguments[0], {
      serverName: 'cat-cafe-memory',
      toolName: 'cat_cafe_list_session_chain',
      arguments: { threadId: 'thread-1', catId: 'antig-opus', limit: 5 },
    });
  });

  test('falls back to wrapper MCP arguments when nested arguments JSON is malformed', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);

    const executeMock = mock.fn(async () => ({
      status: 'success',
      output: { content: [{ type: 'text', text: 'ok' }] },
      stdout: 'ok',
      durationMs: 1,
    }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'call_mcp_tool',
      canHandle: (step) => step.metadata?.toolCall?.name === 'call_mcp_tool',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const step = {
      type: 'CORTEX_STEP_TYPE_MCP_TOOL',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_mcp',
          name: 'call_mcp_tool',
          argumentsJson: JSON.stringify({
            ServerName: 'cat-cafe-memory',
            ToolName: 'cat_cafe_list_session_chain',
            Arguments: JSON.stringify({ threadId: 'thread-wrapper', catId: 'antig-opus', limit: 3 }),
          }),
        },
        sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 3, cascadeId: 'c1' },
      },
      mcpTool: {
        serverName: 'cat-cafe-memory',
        toolCall: {
          name: 'cat_cafe_list_session_chain',
          argumentsJson: '{not-json',
        },
      },
    };

    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });

    assert.equal(handled, true);
    assert.equal(executeMock.mock.callCount(), 1);
    assert.deepEqual(executeMock.mock.calls[0].arguments[0], {
      serverName: 'cat-cafe-memory',
      toolName: 'cat_cafe_list_session_chain',
      arguments: { threadId: 'thread-wrapper', catId: 'antig-opus', limit: 3 },
    });
  });

  test('returns no_executor when call_mcp_tool payload cannot be decoded', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({}));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);
    const executeMock = mock.fn(async () => ({ status: 'success', stdout: 'should-not-run' }));
    const registry = new ExecutorRegistry();
    registry.register({
      toolName: 'call_mcp_tool',
      canHandle: (step) => step.metadata?.toolCall?.name === 'call_mcp_tool',
      execute: executeMock,
    });
    bridge.attachExecutors(registry, new AuditLogger(logDir));

    const handled = await bridge.nativeExecuteAndPush(
      {
        type: 'CORTEX_STEP_TYPE_MCP_TOOL',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: { id: 'toolu_mcp', name: 'call_mcp_tool', argumentsJson: '{}' },
          sourceTrajectoryStepInfo: { trajectoryId: 'traj-1', stepIndex: 3, cascadeId: 'c1' },
        },
      },
      { cascadeId: 'c1', cwd: '/tmp' },
    );

    assert.equal(handled, 'no_executor');
    assert.equal(executeMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
  });

  test('skips when executor not attached', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    const step = makeStep();
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
  });

  test('returns false when sourceTrajectoryStepInfo is missing — refuses to default stepIndex to 0', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_no_step_info',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo danger', Cwd: '/tmp', SafeToAutoRun: true }),
        },
      },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false, 'must not execute when stepIndex is unknown — would cancel wrong step');
    const cancelCalls = rpcMock.mock.calls.filter((c) => {
      const args = c.arguments;
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      return method === 'CancelCascadeSteps';
    });
    assert.equal(cancelCalls.length, 0, 'must not call CancelCascadeSteps without valid stepIndex');
  });

  test('yolo-executes run_command when SafeToAutoRun is not true by default', async () => {
    const { bridge, rpcMock } = makeBridge();
    const variants = [
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false },
      { CommandLine: 'echo hi', Cwd: '/tmp' }, // missing flag
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 'true' }, // string, not bool
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 1 }, // number, not bool
    ];
    for (const args of variants) {
      const step = {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: { id: 'toolu_gate', name: 'run_command', argumentsJson: JSON.stringify(args) },
          sourceTrajectoryStepInfo: { trajectoryId: 't1', stepIndex: 2, cascadeId: 'c1' },
        },
      };
      const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
      assert.equal(handled, true, `must yolo-execute when SafeToAutoRun=${JSON.stringify(args.SafeToAutoRun)}`);
    }
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.equal(methods.filter((method) => method === 'RunCommand').length, variants.length);
    assert.equal(bridge.sendMessage.mock.callCount(), variants.length);
  });

  test('returns approval_pending when yolo run_command is explicitly disabled', async () => {
    const previous = process.env.ANTIGRAVITY_YOLO_RUN_COMMAND;
    process.env.ANTIGRAVITY_YOLO_RUN_COMMAND = 'false';
    try {
      const { bridge, rpcMock } = makeBridge();
      const step = {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: {
            id: 'toolu_gate',
            name: 'run_command',
            argumentsJson: JSON.stringify({ CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false }),
          },
          sourceTrajectoryStepInfo: { trajectoryId: 't1', stepIndex: 2, cascadeId: 'c1' },
        },
      };

      const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });

      assert.equal(handled, 'approval_pending');
      assert.equal(rpcMock.mock.callCount(), 0);
      assert.equal(bridge.sendMessage.mock.callCount(), 0);
    } finally {
      if (previous === undefined) {
        delete process.env.ANTIGRAVITY_YOLO_RUN_COMMAND;
      } else {
        process.env.ANTIGRAVITY_YOLO_RUN_COMMAND = previous;
      }
    }
  });

  test('writes audit entry with result', async () => {
    const { bridge, logDir } = makeBridge();
    const step = makeStep({ commandLine: 'ls' });
    await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const entry = JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim());
    assert.equal(entry.tool, 'run_command');
    assert.equal(entry.cascadeId, 'c1');
    assert.equal(entry.input.commandLine, 'ls');
    assert.equal(entry.result.status, 'success');
  });
});
