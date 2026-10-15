import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAcpSessionState,
  transformAcpEvent,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-event-transformer.js';

const event = (update, state) =>
  transformAcpEvent({ sessionId: 'fixture', update }, 'codex', { provider: 'fixture', model: 'fixture' }, state);
function started() {
  const state = createAcpSessionState();
  event(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'native',
      name: 'Read',
      status: 'pending',
      rawInput: { path: 'original' },
      rawOutput: 'previous',
      content: [{ type: 'content', content: { type: 'text', text: 'previous' } }],
    },
    state,
  );
  return state;
}
const finish = (state, patch) =>
  event({ sessionUpdate: 'tool_call_update', toolCallId: 'native', status: 'completed', ...patch }, state);
test('omitted patch fields preserve existing raw facts', () => {
  const result = finish(started(), {});
  assert.deepEqual(result.toolInput, { path: 'original' });
  assert.equal(result.toolRawPayload.rawOutput, 'previous');
});
test('standard experimental name null preserves the known programmatic name', () => {
  assert.equal(finish(started(), { name: null, title: 'Updated display title' }).toolName, 'Read');
});
test('explicit name null takes precedence over conflicting legacy name aliases', () => {
  assert.equal(finish(started(), { name: null, toolName: 'Wrong', tool_name: 'Wrong' }).toolName, 'Read');
});
test('explicit rawInput null is retained as a new raw fact ahead of legacy aliases', () => {
  const result = finish(started(), { rawInput: null, toolInput: { path: 'wrong alias' } });
  assert.equal(result.toolRawPayload.rawInput, null);
  assert.deepEqual(result.toolInput, { rawInput: null });
});
test('explicit rawOutput null replaces the old raw output', () => {
  const result = finish(started(), { rawOutput: null, content: [] });
  assert.equal(result.toolRawPayload.rawOutput, null);
  assert.equal(result.content, '');
});
test('explicit content null retains the fact and clears the old content collection', () => {
  const result = finish(started(), { content: null, rawOutput: null });
  assert.equal(result.toolRawPayload.content, null);
  assert.equal(result.content, '');
});
test('empty content array replaces the old collection independently of raw output', () => {
  const result = finish(started(), { content: [] });
  assert.deepEqual(result.toolRawPayload.content, []);
  assert.equal(result.content, 'previous');
});
