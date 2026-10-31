import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toStoredToolEvent } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

const use = (): AgentMessage => ({
  type: 'tool_use',
  catId: 'codex61-sol' as AgentMessage['catId'],
  timestamp: 1,
  toolName: 'Read',
  toolUseId: 'native-pair',
  invocationId: 'child',
});

test('API tool event birth is reused by live and persistent projections of the same event', () => {
  const message = use();
  const stored = toStoredToolEvent(message);
  assert.equal(message.toolEventId, stored?.id);
  assert.equal(toStoredToolEvent(message)?.id, stored?.id);
  assert.equal(stored?.executionRef, 'child');
});

test('use/result instances are distinct even when the native pair key and timestamp are shared', () => {
  const first = use();
  const result: AgentMessage = { ...use(), type: 'tool_result', content: 'read result' };
  const a = toStoredToolEvent(first);
  const b = toStoredToolEvent(result);
  assert.notEqual(a?.id, b?.id);
  assert.equal(a?.toolUseId, b?.toolUseId);
  assert.equal(result.toolEventId, b?.id);
});

test('a route-bound child is retained when the provider emits no invocation ID', () => {
  const message = use();
  delete message.invocationId;
  assert.equal(toStoredToolEvent(message, 'bound-child')?.executionRef, 'bound-child');
  assert.equal(message.toolExecutionRef, 'bound-child');
});
