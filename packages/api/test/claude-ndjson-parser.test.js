/**
 * claude-ndjson-parser pure function tests
 * F045: NDJSON 可观测性 — Claude parser 补全
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { isResultErrorEvent, transformClaudeEvent } = await import(
  '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js'
);

const CAT = 'opus';

function makeStreamState() {
  return {
    currentMessageId: undefined,
    partialTextMessageIds: new Set(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
}

// ─── Regression guards ────────────────────────────────────────────────────────

test('system/init → session_init', () => {
  const state = makeStreamState();
  const event = { type: 'system', subtype: 'init', session_id: 'sess-abc' };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null, 'should not return null');
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'session_init');
  assert.equal(result.catId, CAT);
  assert.equal(result.sessionId, 'sess-abc');
});

test('system/init with array mcp_servers → session_init + system_info(mcp_server_status)', () => {
  const state = makeStreamState();
  const event = {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-mcp',
    mcp_servers: [
      { name: 'MCP_DOCKER', status: 'pending' },
      { name: 'playwright', status: 'connected' },
      { name: 'jetbrains', status: 'failed' },
      { name: 'plugin:figma:figma', status: 'disabled' },
      { name: 'claude.ai Gmail', status: 'needs-auth' },
      { name: 'ignored_unknown_status', status: 'connecting' },
      { name: '', status: 'pending' },
      { status: 'pending' },
    ],
  };

  const result = transformClaudeEvent(event, CAT, state);

  assert.ok(Array.isArray(result), 'mcp status telemetry should accompany session_init');
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'session_init');
  assert.equal(result[0].sessionId, 'sess-mcp');
  assert.equal(result[1].type, 'system_info');

  const parsed = JSON.parse(result[1].content);
  assert.equal(parsed.type, 'mcp_server_status');
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.catId, CAT);
  assert.equal(parsed.sessionId, 'sess-mcp');
  assert.equal(parsed.pendingMeaning, 'deferred_tool_loading');
  assert.deepEqual(parsed.counts, {
    connected: 1,
    pending: 1,
    failed: 1,
    disabled: 1,
    'needs-auth': 1,
  });
  assert.deepEqual(parsed.pendingServers, ['MCP_DOCKER']);
  assert.deepEqual(parsed.failedServers, ['jetbrains']);
  assert.deepEqual(parsed.needsAuthServers, ['claude.ai Gmail']);
  assert.deepEqual(
    parsed.servers.map((server) => [server.name, server.status]),
    [
      ['MCP_DOCKER', 'pending'],
      ['playwright', 'connected'],
      ['jetbrains', 'failed'],
      ['plugin:figma:figma', 'disabled'],
      ['claude.ai Gmail', 'needs-auth'],
    ],
  );
});

test('system/init with object mcp_servers keeps backward-compatible telemetry parsing', () => {
  const state = makeStreamState();
  const event = {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-mcp-object',
    mcp_servers: {
      MCP_DOCKER: 'pending',
      future_object_shape: { status: 'pending' },
      ignored_unknown_status: 'connecting',
    },
  };

  const result = transformClaudeEvent(event, CAT, state);

  assert.ok(Array.isArray(result), 'mcp status telemetry should accompany session_init');
  const parsed = JSON.parse(result[1].content);
  assert.deepEqual(parsed.counts, {
    connected: 0,
    pending: 2,
    failed: 0,
    disabled: 0,
    'needs-auth': 0,
  });
  assert.deepEqual(
    parsed.servers.map((server) => [server.name, server.status]),
    [
      ['MCP_DOCKER', 'pending'],
      ['future_object_shape', 'pending'],
    ],
  );
});

test('stream_event text_delta → text', () => {
  const state = makeStreamState();
  state.currentMessageId = 'msg-1';
  const event = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'text');
  assert.equal(result.content, 'hello');
});

test('assistant tool_use → tool_use', () => {
  const state = makeStreamState();
  const event = {
    type: 'assistant',
    message: {
      id: 'msg-2',
      content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }],
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'tool_use');
  assert.equal(result[0].toolName, 'bash');
});

test('result/error → error', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error', errors: ['something went wrong'] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  assert.ok(result.error.includes('something went wrong'));
});

// ─── Task 4 — thinking_delta ──────────────────────────────────────────────────

test('content_block_start thinking resets buffer', () => {
  const state = makeStreamState();
  state.thinkingBuffer = 'stale content';
  const event = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'thinking' },
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.equal(result, null);
  assert.equal(state.thinkingBuffer, '');
});

test('thinking_delta × 2 accumulates in buffer', () => {
  const state = makeStreamState();
  const delta1 = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'first chunk ' },
    },
  };
  const delta2 = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'second chunk' },
    },
  };
  const r1 = transformClaudeEvent(delta1, CAT, state);
  const r2 = transformClaudeEvent(delta2, CAT, state);
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(state.thinkingBuffer, 'first chunk second chunk');
});

test('content_block_stop with thinking buffer → system_info(thinking)', () => {
  const state = makeStreamState();
  state.thinkingBuffer = 'my thought';
  const event = {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'system_info');
  assert.equal(result.catId, CAT);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.type, 'thinking');
  assert.equal(parsed.catId, CAT);
  assert.equal(parsed.text, 'my thought');
  // buffer should be cleared
  assert.equal(state.thinkingBuffer, '');
});

test('content_block_stop without thinking buffer → null', () => {
  const state = makeStreamState();
  state.thinkingBuffer = '';
  const event = {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.equal(result, null);
});

test('full thinking flow: block_start + delta × 2 + block_stop → system_info', () => {
  const state = makeStreamState();

  // reset
  const start = {
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'thinking' } },
  };
  assert.equal(transformClaudeEvent(start, CAT, state), null);

  // accumulate
  const d1 = {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'part A ' } },
  };
  const d2 = {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'part B' } },
  };
  assert.equal(transformClaudeEvent(d1, CAT, state), null);
  assert.equal(transformClaudeEvent(d2, CAT, state), null);

  // emit
  const stop = {
    type: 'stream_event',
    event: { type: 'content_block_stop' },
  };
  const result = transformClaudeEvent(stop, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'system_info');
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.text, 'part A part B');
});

test('signature_delta → null (ignored)', () => {
  const state = makeStreamState();
  const event = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'signature_delta', signature: 'abc123' },
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.equal(result, null);
});

// ─── Task 5 — error subtypes ──────────────────────────────────────────────────

test('result error_max_turns → error with errorSubtype in content', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_max_turns', errors: [] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  assert.ok(result.content, 'content should be set');
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.errorSubtype, 'error_max_turns');
});

test('result error_max_budget_usd → error with errorSubtype in content', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_max_budget_usd', errors: [] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.errorSubtype, 'error_max_budget_usd');
});

test('result error_during_execution → error with errorSubtype in content', () => {
  const state = makeStreamState();
  const event = {
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['execution failed'],
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.errorSubtype, 'error_during_execution');
});

test('result success + is_error:true → error using result text (Claude A2 shape)', () => {
  const state = makeStreamState();
  const event = {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: "The model's tool call could not be parsed (retry also failed).",
    errors: null,
  };
  assert.equal(isResultErrorEvent(event), true, 'is_error:true is authoritative even when subtype is success');
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  assert.match(result.error, /could not be parsed/);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.errorSubtype, 'success');
  assert.equal(parsed.isError, true);
});

// ─── Issue #24 — error.error should never be "Unknown error" when subtype is known ──

test('error_max_turns with empty errors → error.error should be "Max turns exceeded"', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_max_turns', errors: [] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  assert.equal(result.error, 'Max turns exceeded', 'should use subtype label as fallback');
});

test('error_max_budget_usd with empty errors → error.error should be "Budget limit reached"', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_max_budget_usd', errors: [] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'error');
  assert.equal(result.error, 'Budget limit reached', 'should use subtype label as fallback');
});

test('error_during_execution with errors → error.error uses errors array (not subtype)', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_during_execution', errors: ['execution failed'] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.error, 'execution failed', 'errors array should take precedence over subtype label');
});

test('unknown subtype with empty errors → error.error includes subtype string', () => {
  const state = makeStreamState();
  const event = { type: 'result', subtype: 'error_new_future_type', errors: [] };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.notEqual(result.error, 'Unknown error', 'even unknown subtypes should not produce "Unknown error"');
  assert.ok(
    result.error.includes('error_new_future_type'),
    'error should contain the raw subtype string for unknown subtypes',
  );
});

// ─── Task 6 — system events ───────────────────────────────────────────────────

test('system compact_boundary → system_info(compact_boundary) with preTokens', () => {
  const state = makeStreamState();
  const event = { type: 'system', subtype: 'compact_boundary', pre_tokens: 42000 };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'system_info');
  assert.equal(result.catId, CAT);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.type, 'compact_boundary');
  assert.equal(parsed.catId, CAT);
  assert.equal(parsed.preTokens, 42000);
});

test('rate_limit_event → system_info(rate_limit) with utilization and resetsAt', () => {
  const state = makeStreamState();
  const event = {
    type: 'rate_limit_event',
    utilization: 0.87,
    resets_at: '2026-02-27T12:00:00Z',
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null);
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'system_info');
  assert.equal(result.catId, CAT);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.type, 'rate_limit');
  assert.equal(parsed.catId, CAT);
  assert.equal(parsed.utilization, 0.87);
  assert.equal(parsed.resetsAt, '2026-02-27T12:00:00Z');
});

// ── Empty text suppression in assistant events (empty bubble fix) ──

test('assistant event with only empty text block → null (no empty bubble)', () => {
  const state = makeStreamState();
  const event = {
    type: 'assistant',
    message: {
      id: 'msg-empty',
      content: [{ type: 'text', text: '' }],
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.equal(result, null, 'assistant event with only empty text block should return null');
});

// ── #778 + #805 review P3-4: thinking-only assistant message fixture ──
// Real Claude non-streaming response where content = [{ type: 'thinking', thinking: '...' }]
// with no text or tool_use blocks. This is the exact pattern that caused silent_completion
// before the #778 fix. Serves as regression test for Claude API spec drift.

test('assistant thinking-only message → system_info(thinking) (non-streaming fixture)', () => {
  const state = makeStreamState();
  // Real Claude API shape: content block has `type: 'thinking'` and `thinking: '...'` field
  const event = {
    type: 'assistant',
    message: {
      id: 'msg-thinking-only',
      content: [
        {
          type: 'thinking',
          thinking: 'I need to analyze this problem step by step...',
        },
      ],
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null, 'thinking-only message must not return null');
  assert.ok(!Array.isArray(result), 'should return single message');
  assert.equal(result.type, 'system_info');
  assert.equal(result.catId, CAT);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.type, 'thinking');
  assert.equal(parsed.catId, CAT);
  assert.equal(parsed.text, 'I need to analyze this problem step by step...');
});

test('assistant thinking-only with `text` field fallback → system_info(thinking)', () => {
  const state = makeStreamState();
  // Some API versions may use `text` instead of `thinking` field
  const event = {
    type: 'assistant',
    message: {
      id: 'msg-thinking-text-fallback',
      content: [
        {
          type: 'thinking',
          text: 'Fallback thinking content',
        },
      ],
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(result !== null, 'thinking-only (text fallback) must not return null');
  assert.ok(!Array.isArray(result));
  assert.equal(result.type, 'system_info');
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.text, 'Fallback thinking content');
});

test('assistant event with empty text block alongside tool_use → only tool_use returned', () => {
  const state = makeStreamState();
  const event = {
    type: 'assistant',
    message: {
      id: 'msg-mix',
      content: [
        { type: 'text', text: '' },
        { type: 'tool_use', name: 'bash', input: { command: 'ls' } },
      ],
    },
  };
  const result = transformClaudeEvent(event, CAT, state);
  assert.ok(Array.isArray(result), 'should return array');
  assert.equal(result.length, 1, 'only tool_use, empty text filtered out');
  assert.equal(result[0].type, 'tool_use');
});
