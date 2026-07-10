/**
 * OpenAIChatAdapter Golden-Wire Contract Test — F159 Phase G G2 AC-G25
 *
 * Byte-stable lock on the OpenAI Chat Completions protocol shape:
 * - URL / headers / body
 * - stream_options.include_usage
 * - transcript codec (assistant tool_calls + tool messages)
 * - streaming chunk → neutral event mapping
 * - error text + terminal stop classification
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OpenAIChatAdapter } from '../dist/domains/cats/services/agents/providers/catagent/openai-chat-adapter.js';

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

function sse(data) {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

async function collect(iter) {
  const out = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('OpenAIChatAdapter: identity', () => {
  test('clientFamily and protocolId are stable identifiers', () => {
    const adapter = new OpenAIChatAdapter();
    assert.equal(adapter.clientFamily, 'openai');
    assert.equal(adapter.protocolId, 'openai-chat-v1');
  });
});

describe('OpenAIChatAdapter: buildRequestUrl', () => {
  const adapter = new OpenAIChatAdapter();

  test('undefined baseURL uses default', () => {
    assert.equal(adapter.buildRequestUrl(undefined), 'https://api.openai.com/v1/chat/completions');
  });

  test('empty string baseURL falls back to default', () => {
    assert.equal(adapter.buildRequestUrl(''), 'https://api.openai.com/v1/chat/completions');
  });

  test('/v1 suffix not double-prefixed', () => {
    assert.equal(adapter.buildRequestUrl('https://proxy.example/v1'), 'https://proxy.example/v1/chat/completions');
  });

  test('custom proxy without /v1 keeps full path', () => {
    assert.equal(
      adapter.buildRequestUrl('https://gateway.example/openai'),
      'https://gateway.example/openai/v1/chat/completions',
    );
  });
});

describe('OpenAIChatAdapter: buildRequestHeaders', () => {
  test('produces exact Bearer header set', () => {
    const adapter = new OpenAIChatAdapter();
    assert.deepEqual(adapter.buildRequestHeaders({ apiKey: 'sk-openai-test' }), {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-openai-test',
    });
  });
});

describe('OpenAIChatAdapter: buildRequestBody', () => {
  const adapter = new OpenAIChatAdapter();

  test('minimal body uses stream + include_usage', () => {
    const body = adapter.buildRequestBody({
      model: 'gpt-5.5',
      messages: [adapter.encodeUserPrompt('hi')],
      tools: [],
    });
    const json = JSON.parse(JSON.stringify(body));
    assert.deepEqual(json, {
      model: 'gpt-5.5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test('system prompt is prepended as system message', () => {
    const body = adapter.buildRequestBody({
      model: 'gpt-5.5',
      messages: [adapter.encodeUserPrompt('hi')],
      tools: [],
      systemPrompt: 'You are X.',
    });
    const json = JSON.parse(JSON.stringify(body));
    assert.deepEqual(json.messages[0], { role: 'system', content: 'You are X.' });
    assert.deepEqual(json.messages[1], { role: 'user', content: 'hi' });
  });

  test('tools map to OpenAI function tool schema', () => {
    const body = adapter.buildRequestBody({
      model: 'gpt-5.5',
      messages: [adapter.encodeUserPrompt('read file')],
      tools: [{ name: 'read_file', description: 'Read file', inputSchema: { type: 'object' } }],
    });
    const json = JSON.parse(JSON.stringify(body));
    assert.deepEqual(json.tools, [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read file',
          parameters: { type: 'object' },
        },
      },
    ]);
  });
});

describe('OpenAIChatAdapter: transcript codec', () => {
  const adapter = new OpenAIChatAdapter();

  test('encodeAssistantTurn emits assistant content + tool_calls losslessly', () => {
    const body = adapter.buildRequestBody({
      model: 'gpt-5.5',
      messages: [
        adapter.encodeUserPrompt('go'),
        adapter.encodeAssistantTurn([
          { type: 'text', text: 'Thinking...' },
          { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
        ]),
      ],
      tools: [],
    });
    const json = JSON.parse(JSON.stringify(body));
    assert.deepEqual(json.messages[1], {
      role: 'assistant',
      content: 'Thinking...',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"a.txt"}',
          },
        },
      ],
    });
  });

  test('encodeToolResults emits role=tool messages keyed by tool_call_id', () => {
    const body = adapter.buildRequestBody({
      model: 'gpt-5.5',
      messages: [
        adapter.encodeUserPrompt('go'),
        adapter.encodeToolResults([
          { id: 'call_1', content: 'file body', status: 'ok' },
          { id: 'call_2', content: 'Error: nope', status: 'error' },
        ]),
      ],
      tools: [],
    });
    const json = JSON.parse(JSON.stringify(body));
    assert.deepEqual(json.messages.slice(1), [
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
      { role: 'tool', tool_call_id: 'call_2', content: 'Error: nope' },
    ]);
  });
});

describe('OpenAIChatAdapter: parseStreamEvents', () => {
  test('text deltas + final usage + stop are normalised', async () => {
    const adapter = new OpenAIChatAdapter();
    const stream = [
      sse({
        id: 'chatcmpl-1',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
      }),
      sse({
        id: 'chatcmpl-1',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }],
      }),
      sse({
        id: 'chatcmpl-1',
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
      }),
      sse('[DONE]'),
    ].join('');
    const events = await collect(adapter.parseStreamEvents(toStream([stream])));
    assert.deepEqual(
      events.filter((event) => event.type === 'text_delta').map((event) => event.text),
      ['Hel', 'lo'],
    );
    const stop = events.find((event) => event.type === 'stop');
    assert.equal(stop?.stopReason, 'stop');
    const usage = events.find((event) => event.type === 'usage_update');
    assert.deepEqual(usage?.usage, { inputTokens: 12, outputTokens: 4, cacheReadTokens: 3 });
    const complete = events.find((event) => event.type === 'content_block_complete');
    assert.deepEqual(complete?.block, { type: 'text', text: 'Hello' });
  });

  test('tool_calls delta is reassembled into neutral tool_call block', async () => {
    const adapter = new OpenAIChatAdapter();
    const stream = [
      sse({
        id: 'chatcmpl-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  function: { name: 'read_file', arguments: '{"path":"a' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sse({
        id: 'chatcmpl-2',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      sse('[DONE]'),
    ].join('');
    const events = await collect(adapter.parseStreamEvents(toStream([stream])));
    const complete = events.find((event) => event.type === 'content_block_complete');
    assert.equal(complete?.block.type, 'tool_call');
    assert.equal(complete?.block.id, 'call_abc');
    assert.equal(complete?.block.name, 'read_file');
    assert.deepEqual(complete?.block.input, { path: 'a.txt' });
    const stop = events.find((event) => event.type === 'stop');
    assert.equal(stop?.stopReason, 'tool_calls');
  });

  test('missing [DONE] yields stream_error', async () => {
    const adapter = new OpenAIChatAdapter();
    const stream = sse({
      id: 'chatcmpl-3',
      choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }],
    });
    const events = await collect(adapter.parseStreamEvents(toStream([stream])));
    const error = events.find((event) => event.type === 'stream_error');
    assert.match(error?.error ?? '', /\[DONE\]/);
  });

  test('malformed data frame after tool-call deltas fails closed (no tool_call executed)', async () => {
    const adapter = new OpenAIChatAdapter();
    const stream = [
      // Valid partial tool_call delta — accumulates a pending tool call.
      sse({
        id: 'chatcmpl-bad',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_x', function: { name: 'run_command', arguments: '{"binary":"rm"' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      // Malformed JSON where the finish frame should be — must not be swallowed.
      sse('{"choices":[{"index":0,'),
      // A trailing [DONE] must NOT be able to "cleanly" close the corrupt turn.
      sse('[DONE]'),
    ].join('');
    const events = await collect(adapter.parseStreamEvents(toStream([stream])));

    const error = events.find((event) => event.type === 'stream_error');
    assert.ok(error, 'malformed frame must surface a stream_error');
    assert.match(error.error, /malformed/i);

    const toolBlock = events.find(
      (event) => event.type === 'content_block_complete' && event.block?.type === 'tool_call',
    );
    assert.equal(toolBlock, undefined, 'accumulated tool_call must not be emitted after a parse error');
    const stop = events.find((event) => event.type === 'stop');
    assert.equal(stop, undefined, 'no normal stop should follow a malformed frame');
  });
});

describe('OpenAIChatAdapter: mapError + terminal stop reasons', () => {
  test('mapError emits OpenAI-shaped error text', () => {
    const adapter = new OpenAIChatAdapter();
    assert.deepEqual(adapter.mapError({ status: 429, message: 'rate limited' }), {
      errorText: 'OpenAI API error (429): rate limited',
    });
  });

  test('terminal stop reasons match Chat Completions semantics', () => {
    const adapter = new OpenAIChatAdapter();
    for (const reason of ['stop', 'length', 'content_filter']) {
      assert.equal(adapter.isTerminalStopReason(reason), true);
    }
    for (const reason of ['tool_calls', 'function_call', null, undefined, 'future_reason', '']) {
      assert.equal(adapter.isTerminalStopReason(reason ?? null), false);
    }
  });
});
