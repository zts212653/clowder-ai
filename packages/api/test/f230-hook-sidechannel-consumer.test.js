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

test('hook consumer: PostToolUse event → tool_use + tool_result AgentMessages', () => {
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
  assert.equal(msgs.length, 2, 'PostToolUse emits tool_use + tool_result');
  assert.equal(msgs[0].type, 'tool_use');
  assert.equal(msgs[0].toolName, 'Read');
  assert.deepEqual(msgs[0].toolInput, { file_path: '/foo/bar.ts' });
  assert.equal(msgs[0].toolUseId, 'tu_001');
  assert.equal(msgs[0].catId, 'opus');
  // LI-005: tool_result companion — PostToolUse = success event
  assert.equal(msgs[1].type, 'tool_result');
  assert.equal(msgs[1].content, 'file contents here');
  assert.equal(msgs[1].toolUseId, 'tu_001');
  assert.equal(msgs[1].toolResultStatus, 'ok', 'PostToolUse = success → ok');
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

test('hook consumer: mixed PostToolUse + Stop → correct order (use/result pairs)', () => {
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
  // 2 PostToolUse × (tool_use + tool_result) + 1 Stop(text) = 5
  assert.equal(msgs.length, 5);
  assert.equal(msgs[0].type, 'tool_use');
  assert.equal(msgs[0].toolName, 'Bash');
  assert.equal(msgs[1].type, 'tool_result');
  assert.equal(msgs[1].content, 'file1\nfile2');
  assert.equal(msgs[1].toolResultStatus, 'ok');
  assert.equal(msgs[2].type, 'tool_use');
  assert.equal(msgs[2].toolName, 'Read');
  assert.equal(msgs[3].type, 'tool_result');
  assert.equal(msgs[3].content, 'contents');
  assert.equal(msgs[3].toolResultStatus, 'ok');
  assert.equal(msgs[4].type, 'text');
  assert.equal(msgs[4].content, 'Done!');
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

// ---------------------------------------------------------------------------
// LI-005: PostToolUse → tool_result bridge (durable trigger classification)
// ---------------------------------------------------------------------------

test('LI-005: PostToolUse with string tool_response → content string, status ok', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'cat_cafe_hold_ball',
      tool_response: '{"status":"ok","held":true}',
      tool_use_id: 'tu_hold',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  const result = msgs.find((m) => m.type === 'tool_result');
  assert.ok(result, 'tool_result must be emitted');
  assert.equal(result.toolResultStatus, 'ok', 'PostToolUse = success event');
  assert.equal(result.content, '{"status":"ok","held":true}');
});

test('LI-005: PostToolUse with structured object tool_response → JSON.stringify', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_response: { type: 'text', file: { content: 'code', totalLines: 50 } },
      tool_use_id: 'tu_read',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  const result = msgs.find((m) => m.type === 'tool_result');
  assert.ok(result);
  assert.equal(result.toolResultStatus, 'ok');
  // Structured response normalized to JSON string
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.type, 'text');
  assert.equal(parsed.file.totalLines, 50);
});

test('LI-005: PostToolUse with object MCP response → classifiable via Level 2', () => {
  // Simulates MCP hold_ball returning structured object (not pre-serialized string)
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'cat_cafe_hold_ball',
      tool_response: { status: 'ok', held: true, taskId: 'hold-42' },
      tool_use_id: 'tu_mcp',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  const result = msgs.find((m) => m.type === 'tool_result');
  assert.ok(result);
  // Normalized content is parseable JSON with status:'ok'
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.status, 'ok');
});

test('LI-005: PostToolUse without tool_response → content undefined', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_use_id: 'tu_noresponse',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  const result = msgs.find((m) => m.type === 'tool_result');
  assert.ok(result);
  assert.equal(result.content, undefined);
  assert.equal(result.toolResultStatus, 'ok', 'PostToolUse still success even without response');
});

// ---------------------------------------------------------------------------
// LI-005: PostToolUseFailure → tool_result(error) bridge
// ---------------------------------------------------------------------------

test('LI-005: PostToolUseFailure → tool_result with error status', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'cat_cafe_hold_ball',
      tool_response: 'Rate limit exceeded',
      tool_use_id: 'tu_fail',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 1, 'PostToolUseFailure emits tool_result only (no tool_use)');
  assert.equal(msgs[0].type, 'tool_result');
  assert.equal(msgs[0].toolResultStatus, 'error');
  assert.equal(msgs[0].content, 'Rate limit exceeded');
  assert.equal(msgs[0].toolUseId, 'tu_fail');
});

test('LI-005: PostToolUseFailure with structured response → normalized', () => {
  const entries = [
    {
      hook_event_name: 'PostToolUseFailure',
      tool_response: { error: 'connection_refused', code: 429 },
      tool_use_id: 'tu_fail2',
    },
  ];
  const msgs = hookEntriesToAgentMessages(entries, { catId: 'opus' });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].toolResultStatus, 'error');
  const parsed = JSON.parse(msgs[0].content);
  assert.equal(parsed.error, 'connection_refused');
});
