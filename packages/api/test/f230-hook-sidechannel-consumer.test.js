/**
 * F230 B-hook: HookSidechannelConsumer unit tests
 *
 * Pure-function tests — no I/O, no Redis, no file system.
 * Validates hook event → AgentMessage transforms + terminal detection.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractEntrypointFromHookEntries,
  extractSessionIdFromHookEntries,
  hookEntriesToAgentMessages,
  isHookTerminalEvent,
} from '../dist/domains/cats/services/agents/providers/HookSidechannelConsumer.js';

// ---------------------------------------------------------------------------
// hookEntriesToAgentMessages — Stop event
// ---------------------------------------------------------------------------

test('hook consumer: Stop event → text AgentMessage with full reply', () => {
  const entries = [
    {
      hook_event_name: 'Stop',
      session_id: 'abc-123',
      last_assistant_message: 'Hello world',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[0].content, 'Hello world');
  assert.equal(msgs[0].catId, 'opus');
  assert.equal(typeof msgs[0].timestamp, 'number');
});

test('hook consumer: Stop event with empty message → text with empty content', () => {
  const entries = [
    {
      hook_event_name: 'Stop',
      session_id: 'abc',
      last_assistant_message: '',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'sonnet' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'text');
  assert.equal(msgs[0].content, '');
});

test('hook consumer: Stop event without last_assistant_message field → skipped', () => {
  const entries = [
    {
      hook_event_name: 'Stop',
      session_id: 'abc',
      // missing last_assistant_message
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 0);
});

// ---------------------------------------------------------------------------
// hookEntriesToAgentMessages — PostToolUse event
// ---------------------------------------------------------------------------

test('hook consumer: PostToolUse event → tool_use AgentMessage', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      session_id: 'abc-123',
      tool_name: 'Read',
      tool_input: { file_path: '/foo/bar.ts' },
      tool_response: 'file contents here',
      tool_use_id: 'tu_001',
      duration_ms: 150,
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'tool_use');
  assert.equal(msgs[0].toolName, 'Read');
  assert.deepEqual(msgs[0].toolInput, { file_path: '/foo/bar.ts' });
  assert.equal(msgs[0].toolUseId, 'tu_001');
  assert.equal(msgs[0].catId, 'opus');
});

test('hook consumer: PostToolUse with missing tool_name → skipped', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      // missing tool_name
      tool_input: {},
      tool_response: '',
      tool_use_id: 'tu_002',
      duration_ms: 50,
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 0);
});

// ---------------------------------------------------------------------------
// hookEntriesToAgentMessages — mixed events
// ---------------------------------------------------------------------------

test('hook consumer: mixed PostToolUse + Stop → correct order', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file1\nfile2',
      tool_use_id: 'tu_a',
      duration_ms: 200,
    },
    {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_response: 'contents',
      tool_use_id: 'tu_b',
      duration_ms: 80,
    },
    {
      hook_event_name: 'Stop',
      session_id: 'abc',
      last_assistant_message: 'Done!',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].type, 'tool_use');
  assert.equal(msgs[0].toolName, 'Bash');
  assert.equal(msgs[1].type, 'tool_use');
  assert.equal(msgs[1].toolName, 'Read');
  assert.equal(msgs[2].type, 'text');
  assert.equal(msgs[2].content, 'Done!');
});

test('hook consumer: unknown event type → skipped', () => {
  const entries = [
    { hook_event_name: 'PreToolUse', session_id: 'abc', tool_name: 'X' },
    { type: 'system', subtype: 'turn_duration' }, // transcript entry, not hook
    null,
    42,
    'string',
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 0);
});

test('hook consumer: empty entries → empty messages', () => {
  const msgs = hookEntriesToAgentMessages([], { catId: 'opus' });
  assert.equal(msgs.length, 0);
});

// ---------------------------------------------------------------------------
// isHookTerminalEvent
// ---------------------------------------------------------------------------

test('hook consumer: isHookTerminalEvent — Stop = true', () => {
  assert.equal(isHookTerminalEvent({ hook_event_name: 'Stop' }), true);
});

test('hook consumer: isHookTerminalEvent — PostToolUse = false', () => {
  assert.equal(isHookTerminalEvent({ hook_event_name: 'PostToolUse' }), false);
});

test('hook consumer: isHookTerminalEvent — transcript system entry = false', () => {
  assert.equal(isHookTerminalEvent({ type: 'system', subtype: 'turn_duration' }), false);
});

test('hook consumer: isHookTerminalEvent — null/undefined/string = false', () => {
  assert.equal(isHookTerminalEvent(null), false);
  assert.equal(isHookTerminalEvent(undefined), false);
  assert.equal(isHookTerminalEvent('Stop'), false);
});

// ---------------------------------------------------------------------------
// extractSessionIdFromHookEntries
// ---------------------------------------------------------------------------

test('hook consumer: extractSessionIdFromHookEntries — returns first session_id', () => {
  const entries = [
    { hook_event_name: 'PostToolUse', session_id: 'abc-123', tool_name: 'X' },
    { hook_event_name: 'Stop', session_id: 'abc-123', last_assistant_message: '' },
  ];
  assert.equal(extractSessionIdFromHookEntries(entries), 'abc-123');
});

test('hook consumer: extractSessionIdFromHookEntries — empty entries → undefined', () => {
  assert.equal(extractSessionIdFromHookEntries([]), undefined);
});

test('hook consumer: extractSessionIdFromHookEntries — no session_id fields → undefined', () => {
  const entries = [
    { hook_event_name: 'PostToolUse', tool_name: 'X' }, // missing session_id
  ];
  assert.equal(extractSessionIdFromHookEntries(entries), undefined);
});

test('hook consumer: extractSessionIdFromHookEntries — non-string session_id → undefined', () => {
  const entries = [{ hook_event_name: 'PostToolUse', session_id: 123, tool_name: 'X' }];
  assert.equal(extractSessionIdFromHookEntries(entries), undefined);
});

// ---------------------------------------------------------------------------
// extractEntrypointFromHookEntries (F230 follow-up ①)
// ---------------------------------------------------------------------------

test('hook consumer: extractEntrypointFromHookEntries — returns _cc_entrypoint', () => {
  const entries = [
    { hook_event_name: 'PostToolUse', session_id: 'abc', tool_name: 'X', _cc_entrypoint: 'cli' },
    { hook_event_name: 'Stop', session_id: 'abc', last_assistant_message: '', _cc_entrypoint: 'cli' },
  ];
  assert.equal(extractEntrypointFromHookEntries(entries), 'cli');
});

test('hook consumer: extractEntrypointFromHookEntries — empty entries → undefined', () => {
  assert.equal(extractEntrypointFromHookEntries([]), undefined);
});

test('hook consumer: extractEntrypointFromHookEntries — no _cc_entrypoint → undefined', () => {
  const entries = [{ hook_event_name: 'Stop', session_id: 'abc', last_assistant_message: '' }];
  assert.equal(extractEntrypointFromHookEntries(entries), undefined);
});

test('hook consumer: extractEntrypointFromHookEntries — non-string → undefined', () => {
  const entries = [{ hook_event_name: 'Stop', session_id: 'abc', _cc_entrypoint: 42 }];
  assert.equal(extractEntrypointFromHookEntries(entries), undefined);
});
