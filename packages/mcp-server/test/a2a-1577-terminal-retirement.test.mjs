import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '../dist/server-toolsets.js';
import * as callback from '../dist/tools/callback-tools.js';

test('compiled MCP does not advertise a second ordinary or managed-wake terminal authority', () => {
  for (const name of [
    'cat_cafe_complete_managed_hold', // mcp-cutover-negative-reference: absence
    'cat_cafe_complete_a2a_dispatch', // mcp-cutover-negative-reference: absence
    'cat_cafe_complete_event_wait', // mcp-cutover-negative-reference: absence
    'cat_cafe_run_task_test', // mcp-cutover-negative-reference: absence
  ]) {
    assert.equal(
      CANONICAL_TOOL_REGISTRY.some((tool) => tool.name === name),
      false,
      name,
    );
    assert.equal(
      callback.callbackTools.some((tool) => tool.name === name),
      false,
      name,
    );
  }
  assert.equal(typeof callback.handleCompleteManagedHold, 'undefined');
  assert.equal(typeof callback.handleCompleteA2ADispatch, 'undefined');
});

test('read-only custody inspection remains available without directing callers to retired writers', () => {
  const inspector = callback.callbackTools.find((tool) => tool.name === 'cat_cafe_get_custody_events');
  assert.ok(inspector);
  assert.match(inspector.description, /read-only/);
  assert.doesNotMatch(inspector.description, /complete_a2a_dispatch|complete_managed_hold/);
  assert.deepEqual(Object.keys(inspector.inputSchema).sort(), ['limit', 'sourceMessageId']);
});
