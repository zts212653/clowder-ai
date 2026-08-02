/**
 * CatAgent Phase E Tests — SSE Streaming Integration (AC-E1 ~ AC-E5)
 *
 * Service-level tests with mock SSE fetch, covering streaming text yield,
 * tool collection, usage accumulation, error handling, and agentic loop.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { CatAgentService } = await import('../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js');
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

// ── Helpers ──

async function collect(iter) {
  const msgs = [];
  for await (const msg of iter) msgs.push(msg);
  return msgs;
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseStream(events) {
  const text = events.map(sseEvent).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockStreamingApi(responses) {
  let callIndex = 0;
  return async (_url, _init) => {
    const events = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseStream(events),
    };
  };
}

function openAISseEvent(data) {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function openAIStream(events) {
  const text = events.map(openAISseEvent).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockOpenAIStreamingApi(responses, captures) {
  let callIndex = 0;
  return async (url, init) => {
    if (captures) captures.push({ url: String(url), body: JSON.parse(init.body) });
    const events = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: openAIStream(events),
    };
  };
}

function textTurnEvents(text, stopReason = 'end_turn', inputTokens = 10, outputTokens = 5) {
  return [
    { type: 'message_start', message: { id: `msg${Date.now()}`, usage: { input_tokens: inputTokens } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
}

function toolTurnEvents(toolName, toolInput, toolId = 'tu1') {
  const jsonStr = JSON.stringify(toolInput);
  return [
    { type: 'message_start', message: { id: `msg${Date.now()}`, usage: { input_tokens: 20 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: jsonStr } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
    { type: 'message_stop' },
  ];
}

function openAITextTurnEvents(text, finishReason = 'stop', promptTokens = 10, completionTokens = 5) {
  return [
    {
      id: `chatcmpl-${Date.now()}`,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: finishReason }],
    },
    {
      id: `chatcmpl-${Date.now()}`,
      choices: [],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    },
    '[DONE]',
  ];
}

function openAIToolTurnEvents(toolName, toolInput, toolId = 'call_1') {
  const args = JSON.stringify(toolInput);
  return [
    {
      id: `chatcmpl-${Date.now()}`,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: toolId, function: { name: toolName, arguments: args } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    '[DONE]',
  ];
}

// ── Temp workspace ──

let tmpDir;
let prevCatOpusModel;

before(() => {
  prevCatOpusModel = process.env.CAT_OPUS_MODEL;
  process.env.CAT_OPUS_MODEL = 'claude-opus-4-6';
  tmpDir = join(tmpdir(), `catagent-e-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\n');
  mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(tmpDir, '.cat-cafe', 'accounts.json'),
    JSON.stringify({
      'test-ant': { authType: 'api_key' },
      'test-ant-v1': { authType: 'api_key', baseUrl: 'https://proxy.example/v1' },
    }),
  );
  writeFileSync(
    join(tmpDir, '.cat-cafe', 'credentials.json'),
    JSON.stringify({
      'test-ant': { apiKey: 'sk-test-e' },
      'test-ant-v1': { apiKey: 'sk-test-v1' },
    }),
  );
});

after(() => {
  if (prevCatOpusModel !== undefined) process.env.CAT_OPUS_MODEL = prevCatOpusModel;
  else delete process.env.CAT_OPUS_MODEL;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── Tests ──

describe('E1: streaming text yield', () => {
  let prevFetch;
  let prevEnv;

  before(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    resetMigrationState();
  });
  after(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetMigrationState();
  });

  test('text deltas are yielded as type:text messages', async () => {
    globalThis.fetch = mockStreamingApi([textTurnEvents('Hello world')]);
    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('hi'));

    const textMsgs = msgs.filter((m) => m.type === 'text');
    assert.ok(textMsgs.length >= 1, 'has text messages');
    assert.ok(
      textMsgs.some((m) => m.content.includes('Hello')),
      'contains streamed text',
    );
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'has done',
    );
  });

  test('done event has accumulated usage', async () => {
    globalThis.fetch = mockStreamingApi([textTurnEvents('test', 'end_turn', 50, 25)]);
    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test'));

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done);
    assert.ok(done.metadata.usage, 'has usage');
    assert.ok(done.metadata.usage.inputTokens >= 50, 'input tokens');
    assert.equal(done.metadata.usage.outputTokens, 25, 'output tokens');
  });
});

describe('E2: tool_use collection and execution', () => {
  let prevFetch;
  let prevEnv;

  before(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    resetMigrationState();
  });
  after(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetMigrationState();
  });

  test('multi-turn: tool_use → execute → text → done', async () => {
    globalThis.fetch = mockStreamingApi([
      toolTurnEvents('read_file', { path: 'hello.txt' }),
      textTurnEvents('The file has 3 lines', 'end_turn', 50, 10),
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('read hello.txt', { workingDirectory: tmpDir }));

    const types = msgs.map((m) => m.type);
    assert.ok(types.includes('session_init'));
    assert.ok(types.includes('tool_use'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('text'));
    assert.ok(types.includes('done'));

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done.metadata.usage.inputTokens >= 70, 'accumulated input');
    assert.ok(done.metadata.usage.outputTokens >= 25, 'accumulated output');
  });

  test('assistant content in history includes text + tool_use (P1)', async () => {
    const capturedBodies = [];
    let callIndex = 0;
    globalThis.fetch = async (_url, init) => {
      capturedBodies.push(JSON.parse(init.body));
      const events =
        callIndex === 0
          ? [
              { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read' } },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' },
              },
              {
                type: 'content_block_delta',
                index: 1,
                delta: { type: 'input_json_delta', partial_json: '{"path":"hello.txt"}' },
              },
              { type: 'content_block_stop', index: 1 },
              { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
              { type: 'message_stop' },
            ]
          : textTurnEvents('Done reading');
      callIndex++;
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: sseStream(events),
      };
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    await collect(svc.invoke('read', { workingDirectory: tmpDir }));

    // Second call should have assistant content with BOTH text and tool_use blocks
    assert.ok(capturedBodies.length >= 2, 'at least 2 API calls');
    const secondCall = capturedBodies[1];
    const assistantMsg = secondCall.messages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, 'has assistant message in history');
    assert.ok(Array.isArray(assistantMsg.content), 'content is array');
    assert.ok(
      assistantMsg.content.some((b) => b.type === 'text'),
      'assistant content includes text block',
    );
    assert.ok(
      assistantMsg.content.some((b) => b.type === 'tool_use'),
      'assistant content includes tool_use block',
    );
  });
});

describe('E4: stream error handling', () => {
  let prevFetch;
  let prevEnv;

  before(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    resetMigrationState();
  });
  after(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetMigrationState();
  });

  test('HTTP error on first turn preserves zero usage', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'Overloaded' });

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test'));

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'has done');
    assert.ok(done.metadata.usage, 'usage not undefined');
    assert.equal(done.metadata.usage.inputTokens, 0);
    assert.equal(done.metadata.usage.outputTokens, 0);
  });

  test('stream with missing message_stop yields error + done', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseStream([
        { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        // No message_stop!
      ]),
    });

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test'));

    const error = msgs.find((m) => m.type === 'error');
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(error, 'has error for missing message_stop');
    assert.ok(done, 'has done (no dangle)');
  });

  test('stream error after tool_use emits failed tool_result to close the pair', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: sseStream([
        { type: 'message_start', message: { id: 'msg1', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"hello.txt"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        // No message_stop — stream interrupted!
      ]),
    });

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-ant' },
    });
    const msgs = await collect(svc.invoke('read', { workingDirectory: tmpDir }));

    const toolUse = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolUse, 'tool_use was yielded before error');
    assert.equal(toolUse.toolName, 'read_file');

    const toolResult = msgs.find((m) => m.type === 'tool_result');
    assert.ok(toolResult, 'failed tool_result emitted to close orphan');
    assert.ok(toolResult.content.includes('stream interrupted'), 'explains the failure');
    assert.equal(toolResult.toolName, 'read_file');

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'has done');
  });

  test('stream: true is set in request body', async () => {
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: sseStream(textTurnEvents('hi')),
      };
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    await collect(svc.invoke('test'));

    assert.ok(capturedBody);
    assert.equal(capturedBody.stream, true, 'stream: true in body');
  });

  test('baseUrl ending in /v1 is not double-prefixed', async () => {
    let capturedUrl = null;
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: sseStream(textTurnEvents('hi')),
      };
    };

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-ant-v1' },
    });
    await collect(svc.invoke('test'));

    assert.equal(capturedUrl, 'https://proxy.example/v1/messages');
  });
});

describe('G2 Axis 5: OpenAI Chat protocol e2e', () => {
  let prevFetch;
  let prevEnv;

  before(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    resetMigrationState();
    writeFileSync(
      join(tmpDir, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'test-ant': { authType: 'api_key' },
        'test-ant-v1': { authType: 'api_key', baseUrl: 'https://proxy.example/v1' },
        'test-openai': { authType: 'api_key', clientFamily: 'openai', baseUrl: 'https://proxy.example/v1' },
      }),
    );
    writeFileSync(
      join(tmpDir, '.cat-cafe', 'credentials.json'),
      JSON.stringify({
        'test-ant': { apiKey: 'sk-test-e' },
        'test-ant-v1': { apiKey: 'sk-test-v1' },
        'test-openai': { apiKey: 'sk-openai-e' },
      }),
    );
  });

  after(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetMigrationState();
  });

  test('single-turn text path uses OpenAI URL/headers/body and ends cleanly', async () => {
    const captures = [];
    globalThis.fetch = mockOpenAIStreamingApi([openAITextTurnEvents('Hello from OpenAI')], captures);

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-openai', clientId: 'catagent', catAgentProtocol: 'openai-chat' },
    });
    const msgs = await collect(svc.invoke('hi'));

    const text = msgs
      .filter((msg) => msg.type === 'text')
      .map((msg) => msg.content)
      .join('');
    assert.equal(text, 'Hello from OpenAI');
    assert.ok(msgs.some((msg) => msg.type === 'done'));
    assert.equal(captures[0].url, 'https://proxy.example/v1/chat/completions');
    assert.equal(captures[0].body.messages[0].role, 'user');
    assert.equal(captures[0].body.stream_options.include_usage, true);
  });

  test('tool_call multi-turn path is lossless across assistant history + tool results', async () => {
    const captures = [];
    globalThis.fetch = mockOpenAIStreamingApi(
      [
        openAIToolTurnEvents('read_file', { path: 'hello.txt' }, 'call_read_1'),
        openAITextTurnEvents('The file has 3 lines', 'stop', 50, 9),
      ],
      captures,
    );

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-openai', clientId: 'catagent', catAgentProtocol: 'openai-chat' },
    });
    const msgs = await collect(svc.invoke('read hello.txt', { workingDirectory: tmpDir }));

    assert.ok(msgs.some((msg) => msg.type === 'tool_use' && msg.toolName === 'read_file'));
    assert.ok(msgs.some((msg) => msg.type === 'tool_result' && msg.toolUseId === 'call_read_1'));
    assert.ok(msgs.some((msg) => msg.type === 'text' && msg.content.includes('3 lines')));

    assert.ok(captures.length >= 2, 'must issue second turn');
    const secondMessages = captures[1].body.messages;
    const assistant = secondMessages.find((message) => message.role === 'assistant');
    assert.deepEqual(assistant.tool_calls, [
      {
        id: 'call_read_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"hello.txt"}' },
      },
    ]);
    const toolMessage = secondMessages.find((message) => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'call_read_1');
    assert.match(toolMessage.content, /line1/);
  });
});
