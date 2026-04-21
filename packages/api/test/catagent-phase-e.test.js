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

// ── Temp workspace ──

let tmpDir;

before(() => {
  tmpDir = join(tmpdir(), `catagent-e-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\n');
  mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  writeFileSync(join(tmpDir, '.cat-cafe', 'accounts.json'), JSON.stringify({ 'test-ant': { authType: 'api_key' } }));
  writeFileSync(join(tmpDir, '.cat-cafe', 'credentials.json'), JSON.stringify({ 'test-ant': { apiKey: 'sk-test-e' } }));
});

after(() => {
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
});
