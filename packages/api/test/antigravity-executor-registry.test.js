import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExecutorRegistry } from '../dist/domains/cats/services/agents/providers/antigravity/executors/ExecutorRegistry.js';

function createMockExecutor(toolName) {
  return {
    toolName,
    canHandle(step) {
      return step?.toolCall?.toolName === toolName;
    },
    async execute() {
      return { status: 'success', output: null, durationMs: 0 };
    },
  };
}

describe('ExecutorRegistry', () => {
  test('routes step to executor by toolName', () => {
    const registry = new ExecutorRegistry();
    const runCmd = createMockExecutor('run_command');
    registry.register(runCmd);
    const step = { toolCall: { toolName: 'run_command' } };
    assert.equal(registry.resolve(step), runCmd);
  });

  test('returns null for unknown tool', () => {
    const registry = new ExecutorRegistry();
    const step = { toolCall: { toolName: 'foo_bar' } };
    assert.equal(registry.resolve(step), null);
  });

  test('returns null when step has no toolCall', () => {
    const registry = new ExecutorRegistry();
    assert.equal(registry.resolve({}), null);
  });

  test('throws on duplicate toolName registration', () => {
    const registry = new ExecutorRegistry();
    registry.register(createMockExecutor('run_command'));
    assert.throws(() => registry.register(createMockExecutor('run_command')), /already registered/);
  });

  test('supports multiple distinct executors', () => {
    const registry = new ExecutorRegistry();
    const runCmd = createMockExecutor('run_command');
    const readFile = createMockExecutor('read_file');
    registry.register(runCmd);
    registry.register(readFile);
    assert.equal(registry.resolve({ toolCall: { toolName: 'run_command' } }), runCmd);
    assert.equal(registry.resolve({ toolCall: { toolName: 'read_file' } }), readFile);
  });

  test('resolves from real raw shape (metadata.toolCall.name)', () => {
    const registry = new ExecutorRegistry();
    const runCmd = createMockExecutor('run_command');
    registry.register(runCmd);
    const rawStep = { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', metadata: { toolCall: { name: 'run_command' } } };
    assert.equal(registry.resolve(rawStep), runCmd);
  });
});
