/**
 * CatAgent Stream Parser Tests — F159 Phase E
 *
 * Unit tests for catagent-stream-parser.ts SSE parsing.
 * Tests SSE framing, text deltas, tool JSON accumulation,
 * ping/unknown skip, event:error, truncated streams, EOF validation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { parseAnthropicSSE } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-stream-parser.js'
);

// ── Helpers ──

function toStream(chunks) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

function sseEvent(data, eventType) {
  let s = '';
  if (eventType) s += `event: ${eventType}\n`;
  s += `data: ${JSON.stringify(data)}\n\n`;
  return s;
}

async function collect(stream) {
  const events = [];
  for await (const evt of stream) events.push(evt);
  return events;
}

// ── Tests ──

describe('SSE parser: text streaming', () => {
  test('yields text_delta for each content_block_delta', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const deltas = events.filter((e) => e.type === 'text_delta');
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].text, 'Hello');
    assert.equal(deltas[1].text, ' world');
  });

  test('yields content_block_complete with full text', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const complete = events.find((e) => e.type === 'content_block_complete');
    assert.ok(complete);
    assert.equal(complete.block.type, 'text');
    assert.equal(complete.block.text, 'Hi');
  });
});

describe('SSE parser: tool_use streaming', () => {
  test('accumulates input_json_delta and yields complete tool block', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } }) +
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
      }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pa' } }) +
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'th":"hello.txt"}' },
      }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const complete = events.find((e) => e.type === 'content_block_complete' && e.block.type === 'tool_use');
    assert.ok(complete);
    assert.equal(complete.block.name, 'read_file');
    assert.deepEqual(complete.block.input, { path: 'hello.txt' });
  });

  test('handles invalid tool JSON gracefully', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
      }) +
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{broken' },
      }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const complete = events.find((e) => e.type === 'content_block_complete' && e.block.type === 'tool_use');
    assert.ok(complete);
    assert.ok(complete.block.input._error, 'has error marker');
  });
});

describe('SSE parser: usage and stop', () => {
  test('extracts usage from message_start and message_delta', async () => {
    const sse =
      sseEvent({
        type: 'message_start',
        message: { id: 'msg1', usage: { input_tokens: 100, cache_read_input_tokens: 50 } },
      }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const usageEvents = events.filter((e) => e.type === 'usage_update');
    assert.ok(usageEvents.length >= 1, 'has usage events');
    const inputEvt = usageEvents.find((e) => e.inputUsage);
    assert.ok(inputEvt);
    assert.equal(inputEvt.inputUsage.input_tokens, 100);
    const outputEvt = usageEvents.find((e) => e.outputTokens !== undefined);
    assert.ok(outputEvt);
    assert.equal(outputEvt.outputTokens, 25);
  });

  test('yields stop event with stop_reason', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 100 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const stop = events.find((e) => e.type === 'stop');
    assert.ok(stop);
    assert.equal(stop.stopReason, 'max_tokens');
  });
});

describe('SSE parser: framing edge cases', () => {
  test('handles chunked delivery (SSE split across fetch chunks)', async () => {
    const full =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunked' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
      sseEvent({ type: 'message_stop' });
    // Split into small chunks
    const chunks = [];
    for (let i = 0; i < full.length; i += 20) {
      chunks.push(full.slice(i, i + 20));
    }
    const events = await collect(parseAnthropicSSE(toStream(chunks)));
    const delta = events.find((e) => e.type === 'text_delta');
    assert.ok(delta);
    assert.equal(delta.text, 'chunked');
  });

  test('skips SSE comments (lines starting with :)', async () => {
    const sse =
      ': this is a comment\n' +
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      ': ping\n\n' +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    assert.ok(!events.some((e) => e.type === 'stream_error'), 'no errors from comments');
  });

  test('skips unknown event types', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'future_unknown_event', data: 'whatever' }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    assert.ok(!events.some((e) => e.type === 'stream_error'), 'no errors from unknown events');
  });

  test('maps SSE event:error to stream_error', async () => {
    const sse = 'event: error\ndata: Server overloaded\n\n';
    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const err = events.find((e) => e.type === 'stream_error');
    assert.ok(err);
    assert.ok(err.error.includes('Server overloaded'));
  });
});

describe('SSE parser: EOF validation (P1)', () => {
  test('stream ending without message_stop yields stream_error', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    // No message_stop!

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const err = events.find((e) => e.type === 'stream_error');
    assert.ok(err, 'stream_error emitted for missing message_stop');
    assert.ok(err.error.includes('message_stop'));
  });

  test('stream ending with unclosed content block yields stream_error', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
      }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path"' } });
    // No content_block_stop or message_stop!

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const err = events.find((e) => e.type === 'stream_error');
    assert.ok(err, 'stream_error emitted for unclosed block');
    assert.ok(err.error.includes('unclosed'));
  });

  test('complete stream with message_stop has no stream_error', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    assert.ok(!events.some((e) => e.type === 'stream_error'), 'no stream errors');
  });
});

describe('SSE parser: multi-block ordering', () => {
  test('text + tool_use blocks maintain index order', async () => {
    const sse =
      sseEvent({ type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } }) +
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read that' } }) +
      sseEvent({ type: 'content_block_stop', index: 0 }) +
      sseEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
      }) +
      sseEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"path":"f.txt"}' },
      }) +
      sseEvent({ type: 'content_block_stop', index: 1 }) +
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } }) +
      sseEvent({ type: 'message_stop' });

    const events = await collect(parseAnthropicSSE(toStream([sse])));
    const completes = events.filter((e) => e.type === 'content_block_complete');
    assert.equal(completes.length, 2);
    assert.equal(completes[0].blockIndex, 0);
    assert.equal(completes[0].block.type, 'text');
    assert.equal(completes[1].blockIndex, 1);
    assert.equal(completes[1].block.type, 'tool_use');
  });
});
