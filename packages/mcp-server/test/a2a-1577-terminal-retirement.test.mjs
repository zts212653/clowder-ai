import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as callback from '../dist/tools/callback-tools.js';

test('compiled MCP does not advertise a second ordinary or managed-wake terminal authority', () => {
  for (const name of ['cat_cafe_complete_managed_hold', 'cat_cafe_complete_a2a_dispatch']) {
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
