import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F277 cat_cafe_propose_thread declaredWorkMode contract', () => {
  test('schema exposes the four exact placement modes and explains standalone birth-only semantics', async () => {
    const { createServer } = await import('../dist/index.js');
    const tool = createServer()._registeredTools.cat_cafe_propose_thread;
    const field = tool.inputSchema._def.shape().declaredWorkMode;

    assert.ok(field?.isOptional(), 'declaredWorkMode remains optional for legacy callers');
    const description = field._def.innerType?._def.description ?? field._def.description ?? '';
    assert.match(description, /subtask/);
    assert.match(description, /parallel/);
    assert.match(description, /investigation/);
    assert.match(description, /standalone/);
    assert.match(description, /birth|出生/i);
  });

  test('handler forwards declaredWorkMode to the callback API', async () => {
    const { handleProposeThread } = await import('../dist/tools/callback-tools.js');
    assert.match(handleProposeThread.toString(), /declaredWorkMode/);
  });
});
