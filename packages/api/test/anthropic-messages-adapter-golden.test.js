/**
 * AnthropicMessagesAdapter Golden-Wire Contract Test — F159 Phase G G1 AC-G10
 *
 * Byte-stable lock on the Anthropic Messages protocol shape:
 *
 * - Request URL formation (base URL normalisation: bare host, /v1 suffix,
 *   trailing slash, empty/undefined, custom proxy without /v1)
 * - Request headers (x-api-key, anthropic-version pinned, Content-Type)
 * - Request body JSON shape (model / max_tokens / messages / stream / tools /
 *   system field presence + value structure)
 * - Stream event → neutral CatAgentStreamEvent mapping for every Anthropic
 *   SSE event type (message_start, content_block_*, message_delta, message_stop)
 *   plus boundary cases (unclosed block, missing message_stop)
 * - Transcript codec output shape for encodeUserPrompt /
 *   encodeAssistantTurn / encodeToolResults — verified by round-tripping
 *   through buildRequestBody and asserting on the serialised JSON keys/values
 * - mapError text format byte-stability with pre-G1 mapAnthropicError
 *   ("Anthropic API error (<status>): <msg>")
 * - isTerminalStopReason classification (terminal whitelist intact)
 * - clientFamily / protocolId stable identifiers
 *
 * Per @gpt555 design gate KD-18: refactor-only "behavior保持" cannot be
 * proven by broad suite alone; this contract test locks every protocol
 * detail at byte level so future G2 / G3 changes can't drift Anthropic
 * wire shape silently.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AnthropicMessagesAdapter } from '../dist/domains/cats/services/agents/providers/catagent/anthropic-messages-adapter.js';

// ── helpers ──

function toStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(new TextEncoder().encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function collect(iter) {
  const out = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ── adapter identity ──

describe('AnthropicMessagesAdapter: identity', () => {
  test('clientFamily and protocolId are stable identifiers', () => {
    const a = new AnthropicMessagesAdapter();
    assert.equal(a.clientFamily, 'anthropic');
    assert.equal(a.protocolId, 'anthropic-messages-v1');
  });
});

// ── buildRequestUrl ──

describe('AnthropicMessagesAdapter: buildRequestUrl', () => {
  const a = new AnthropicMessagesAdapter();

  test('undefined baseURL uses default', () => {
    assert.equal(a.buildRequestUrl(undefined), 'https://api.anthropic.com/v1/messages');
  });

  test('empty string baseURL falls back to default', () => {
    assert.equal(a.buildRequestUrl(''), 'https://api.anthropic.com/v1/messages');
  });

  test('bare host preserved + /v1/messages appended', () => {
    assert.equal(a.buildRequestUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages');
  });

  test('trailing slash stripped', () => {
    assert.equal(a.buildRequestUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages');
  });

  test('/v1 suffix not double-prefixed (develop@90810122 fix)', () => {
    assert.equal(a.buildRequestUrl('https://proxy.example/v1'), 'https://proxy.example/v1/messages');
  });

  test('/v1/ suffix (trailing slash variant) handled', () => {
    assert.equal(a.buildRequestUrl('https://proxy.example/v1/'), 'https://proxy.example/v1/messages');
  });

  test('uppercase /V1 suffix case-insensitive', () => {
    assert.equal(a.buildRequestUrl('https://proxy.example/V1'), 'https://proxy.example/v1/messages');
  });

  test('custom proxy without /v1 keeps full path', () => {
    assert.equal(a.buildRequestUrl('https://api.mycorp.com/anthropic'), 'https://api.mycorp.com/anthropic/v1/messages');
  });
});

// ── buildRequestHeaders ──

describe('AnthropicMessagesAdapter: buildRequestHeaders', () => {
  test('produces exact header set with anthropic-version pinned', () => {
    const a = new AnthropicMessagesAdapter();
    const headers = a.buildRequestHeaders({ apiKey: 'sk-test-abc' });
    assert.deepEqual(headers, {
      'Content-Type': 'application/json',
      'x-api-key': 'sk-test-abc',
      'anthropic-version': '2023-06-01',
    });
  });
});

// ── buildRequestBody (round-tripped through encode methods) ──

describe('AnthropicMessagesAdapter: buildRequestBody', () => {
  const a = new AnthropicMessagesAdapter();

  test('minimal body (no tools, no system) — wire-stable keys', () => {
    const messages = [a.encodeUserPrompt('hi')];
    const body = a.buildRequestBody({ model: 'claude-opus-4-6', messages, tools: [] });
    // Round-trip serialise to assert JSON shape byte-stably
    const j = JSON.parse(JSON.stringify(body));
    assert.deepEqual(j, {
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
  });

  test('body with tools — anthropic tool schema shape (name/description/input_schema)', () => {
    const messages = [a.encodeUserPrompt('do thing')];
    const body = a.buildRequestBody({
      model: 'claude-opus-4-6',
      messages,
      tools: [{ name: 'read_file', description: 'reads a file', inputSchema: { type: 'object' } }],
    });
    const j = JSON.parse(JSON.stringify(body));
    assert.deepEqual(j.tools, [{ name: 'read_file', description: 'reads a file', input_schema: { type: 'object' } }]);
  });

  test('body with systemPrompt — placed as top-level "system" field', () => {
    const messages = [a.encodeUserPrompt('q')];
    const body = a.buildRequestBody({ model: 'claude-opus-4-6', messages, tools: [], systemPrompt: 'You are X.' });
    const j = JSON.parse(JSON.stringify(body));
    assert.equal(j.system, 'You are X.');
  });

  test('maxTokens override respected', () => {
    const messages = [a.encodeUserPrompt('q')];
    const body = a.buildRequestBody({ model: 'm', messages, tools: [], maxTokens: 8192 });
    const j = JSON.parse(JSON.stringify(body));
    assert.equal(j.max_tokens, 8192);
  });
});

// ── Transcript codec wire shape ──

describe('AnthropicMessagesAdapter: encodeUserPrompt', () => {
  test('byte-stable Anthropic user message shape', () => {
    const a = new AnthropicMessagesAdapter();
    const msg = a.encodeUserPrompt('hello');
    const body = a.buildRequestBody({ model: 'm', messages: [msg], tools: [] });
    const j = JSON.parse(JSON.stringify(body));
    assert.deepEqual(j.messages, [{ role: 'user', content: 'hello' }]);
  });
});

describe('AnthropicMessagesAdapter: encodeAssistantTurn', () => {
  test('mixed text + tool_call blocks render in Anthropic content order', () => {
    const a = new AnthropicMessagesAdapter();
    const initial = a.encodeUserPrompt('go');
    const assistant = a.encodeAssistantTurn([
      { type: 'text', text: 'thinking…' },
      { type: 'tool_call', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
    const body = a.buildRequestBody({ model: 'm', messages: [initial, assistant], tools: [] });
    const j = JSON.parse(JSON.stringify(body));
    assert.deepEqual(j.messages[1], {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking…' },
        { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.txt' } },
      ],
    });
  });
});

describe('AnthropicMessagesAdapter: encodeToolResults', () => {
  test('byte-stable Anthropic user-message-with-tool_result shape (no is_error in G1)', () => {
    const a = new AnthropicMessagesAdapter();
    const initial = a.encodeUserPrompt('go');
    const tr = a.encodeToolResults([
      { id: 'tu1', content: 'file content', status: 'ok' },
      { id: 'tu2', content: 'Error: nope', status: 'error' },
    ]);
    const body = a.buildRequestBody({ model: 'm', messages: [initial, tr], tools: [] });
    const j = JSON.parse(JSON.stringify(body));
    // G1 refactor-only: NO is_error field on tool_result blocks (locked
    // against accidental introduction; G2+ may surface status). Pre-G1 wire
    // shape preserved exactly.
    assert.deepEqual(j.messages[1], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'file content' },
        { type: 'tool_result', tool_use_id: 'tu2', content: 'Error: nope' },
      ],
    });
  });
});

// ── parseStreamEvents: SSE → neutral event mapping ──

describe('AnthropicMessagesAdapter: parseStreamEvents — text + usage + stop', () => {
  test('message_start usage → neutral CatAgentUsageDelta with cache normalisation', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({
        type: 'message_start',
        message: {
          id: 'm1',
          usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
        },
      }) +
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }) +
      sse({ type: 'content_block_stop', index: 0 }) +
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }) +
      sse({ type: 'message_stop' });
    const events = await collect(a.parseStreamEvents(toStream([stream])));

    const usage = events.find((e) => e.type === 'usage_update' && e.usage.inputTokens !== undefined);
    assert.ok(usage, 'has input usage event');
    // mapAnthropicUsage convention: inputTokens = raw + cache_read + cache_creation
    assert.equal(usage.usage.inputTokens, 160);
    assert.equal(usage.usage.cacheReadTokens, 50);
    assert.equal(usage.usage.cacheCreationTokens, 10);

    const outUsage = events.find((e) => e.type === 'usage_update' && e.usage.outputTokens !== undefined);
    assert.ok(outUsage);
    assert.equal(outUsage.usage.outputTokens, 25);
  });

  test('text_delta → neutral text_delta event with blockIndex preserved', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }) +
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } }) +
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }) +
      sse({ type: 'content_block_stop', index: 0 }) +
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
      sse({ type: 'message_stop' });
    const events = await collect(a.parseStreamEvents(toStream([stream])));
    const deltas = events.filter((e) => e.type === 'text_delta');
    assert.deepEqual(
      deltas.map((e) => ({ text: e.text, blockIndex: e.blockIndex })),
      [
        { text: 'hel', blockIndex: 0 },
        { text: 'lo', blockIndex: 0 },
      ],
    );
  });

  test('stop event carries raw stopReason (service consults isTerminalStopReason separately)', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }) +
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse({ type: 'content_block_stop', index: 0 }) +
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }) +
      sse({ type: 'message_stop' });
    const events = await collect(a.parseStreamEvents(toStream([stream])));
    const stop = events.find((e) => e.type === 'stop');
    assert.ok(stop);
    assert.equal(stop.stopReason, 'tool_use');
  });
});

describe('AnthropicMessagesAdapter: parseStreamEvents — tool_call mapping', () => {
  test('Anthropic tool_use content block → neutral tool_call block (id/name/input preserved)', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }) +
      sse({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
      }) +
      sse({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"x.txt"}' },
      }) +
      sse({ type: 'content_block_stop', index: 0 }) +
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }) +
      sse({ type: 'message_stop' });
    const events = await collect(a.parseStreamEvents(toStream([stream])));
    const complete = events.find((e) => e.type === 'content_block_complete');
    assert.ok(complete);
    assert.equal(complete.block.type, 'tool_call'); // NOT 'tool_use' — neutral
    assert.equal(complete.block.id, 'tu1');
    assert.equal(complete.block.name, 'read_file');
    assert.deepEqual(complete.block.input, { path: 'x.txt' });
  });
});

describe('AnthropicMessagesAdapter: parseStreamEvents — boundary cases', () => {
  test('unclosed content block → stream_error', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }) +
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse({ type: 'message_stop' }); // missing content_block_stop
    const events = await collect(a.parseStreamEvents(toStream([stream])));
    const err = events.find((e) => e.type === 'stream_error');
    assert.ok(err);
    assert.match(err.error, /unclosed content block/i);
  });

  test('missing message_stop → stream_error', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream =
      sse({ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } }) +
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sse({ type: 'content_block_stop', index: 0 });
    // no message_delta, no message_stop
    const events = await collect(a.parseStreamEvents(toStream([stream])));
    const err = events.find((e) => e.type === 'stream_error');
    assert.ok(err);
    assert.match(err.error, /message_stop/i);
  });
});

// ── mapError text format ──

describe('AnthropicMessagesAdapter: mapError', () => {
  test('byte-stable error text matches pre-G1 mapAnthropicError format', () => {
    const a = new AnthropicMessagesAdapter();
    assert.equal(a.mapError({ status: 404, message: 'Not Found' }).errorText, 'Anthropic API error (404): Not Found');
    assert.equal(a.mapError({ status: 500 }).errorText, 'Anthropic API error (500): Unknown API error');
    assert.equal(a.mapError({ message: 'Network failed' }).errorText, 'Anthropic API error (0): Network failed');
  });
});

// ── isTerminalStopReason ──

describe('AnthropicMessagesAdapter: malformed frame fails closed', () => {
  test('tool_use block + malformed frame + message_stop → stream_error, no tool_call emitted', async () => {
    const a = new AnthropicMessagesAdapter();
    const stream = [
      // content_block_start for tool_use
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'write_file' } })}\n\n`,
      // Some valid tool input delta
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } })}\n\n`,
      // Malformed frame — must fail closed
      'event: content_block_delta\ndata: {INVALID JSON\n\n',
      // message_stop — should NOT make the stream look clean
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    const events = await collect(a.parseStreamEvents(toStream([stream])));

    const error = events.find((e) => e.type === 'stream_error');
    assert.ok(error, 'must emit stream_error on malformed frame');
    assert.match(error.error, /malformed/i);

    const toolBlock = events.find((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.equal(toolBlock, undefined, 'tool_call must not be emitted after parse error');
  });
});

describe('AnthropicMessagesAdapter: isTerminalStopReason', () => {
  const a = new AnthropicMessagesAdapter();

  for (const r of ['end_turn', 'max_tokens', 'stop_sequence', 'refusal', 'model_context_window_exceeded']) {
    test(`'${r}' is terminal`, () => {
      assert.equal(a.isTerminalStopReason(r), true);
    });
  }

  for (const r of ['tool_use', 'pause_turn', null, undefined, 'future_reason', '']) {
    test(`${JSON.stringify(r)} is NOT terminal`, () => {
      assert.equal(a.isTerminalStopReason(r), false);
    });
  }
});
