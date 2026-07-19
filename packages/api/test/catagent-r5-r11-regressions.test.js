/**
 * CatAgent R5–R11 Regression Tests
 *
 * Focused coverage for the ten behavior, safety, and protocol changes
 * introduced in commits ae6a9d21a through 2e915e905:
 *
 * R5:  stop_reason positive gate (isToolUseStopReason)
 * R5:  write_file target-type audit parity (rejectWithAudit)
 * R5:  unknown-tool audit fields guard (non-object input)
 * R5:  L0 task-status callback gate (levelAtLeast L1)
 * R6:  family guard before Google gateway bypass
 * R6:  empty patch replacement text (allowEmpty)
 * R7:  empty write content / whitespace-only patch target
 * R8:  OpenAI tool calls without upstream IDs
 * R9:  Anthropic tool_use blocks without upstream IDs
 * R10: non-object Anthropic tool input normalization
 * R11: isToolUseStopReason adapter predicate
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { buildToolRegistry, findTool, resetRgCache } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-read-tools.js'
);
const { CatAgentService, executeCatAgentTools } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js'
);
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');
const { validateToolInput } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-tool-guard.js'
);
const { validateRuntimeProviderBinding } = await import('../dist/config/account-resolver.js');
const { parseAnthropicSSE } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-stream-parser.js'
);
const { AnthropicMessagesAdapter } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/anthropic-messages-adapter.js'
);
const { OpenAIChatAdapter } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/openai-chat-adapter.js'
);

// ── Helpers ──

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

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
  const lines = [];
  if (eventType) lines.push(`event: ${eventType}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join('\n') + '\n\n';
}

async function collectStream(stream) {
  const events = [];
  for await (const evt of stream) events.push(evt);
  return events;
}

let tmpDir;
let outsideDir;

before(() => {
  tmpDir = join(tmpdir(), `catagent-r5r11-${Date.now()}`);
  outsideDir = join(tmpdir(), `catagent-r5r11-outside-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(tmpDir, 'existing.txt'), 'hello world');
  // Credentials for CatAgentService tests
  mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  writeFileSync(join(tmpDir, '.cat-cafe', 'accounts.json'), JSON.stringify({ 'test-ant': { authType: 'api_key' } }));
  writeFileSync(
    join(tmpDir, '.cat-cafe', 'credentials.json'),
    JSON.stringify({ 'test-ant': { apiKey: 'sk-test-r11' } }),
  );
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── R5: unknown-tool audit fields guard (non-object input) ──

describe('R5: unknown-tool non-object input does not crash audit', () => {
  test('null input emits audit without TypeError', async () => {
    const auditEvents = [];
    const results = await executeCatAgentTools(
      [{ id: 'call_1', name: 'nonexistent_tool', type: 'tool_call', input: null }],
      [], // no tools registered
      { audit: (evt) => auditEvents.push(evt) },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'error');
    assert.ok(results[0].content.includes('unknown tool'));
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].outcome, 'rejected');
  });

  test('array input emits audit without TypeError', async () => {
    const auditEvents = [];
    const results = await executeCatAgentTools(
      [{ id: 'call_2', name: 'nonexistent_tool', type: 'tool_call', input: [1, 2, 3] }],
      [],
      { audit: (evt) => auditEvents.push(evt) },
    );
    assert.equal(results[0].status, 'error');
    assert.equal(auditEvents[0].outcome, 'rejected');
    // No path/binary/args should be extracted from array
    assert.equal(auditEvents[0].path, undefined);
  });

  test('string input emits audit without TypeError', async () => {
    const auditEvents = [];
    const results = await executeCatAgentTools(
      [{ id: 'call_3', name: 'nonexistent_tool', type: 'tool_call', input: 'just a string' }],
      [],
      { audit: (evt) => auditEvents.push(evt) },
    );
    assert.equal(results[0].status, 'error');
    assert.equal(auditEvents[0].outcome, 'rejected');
  });
});

// ── R5: L0 task-status callback gate ──

describe('R5: L0 does not register update_current_task_status', () => {
  test('L0 with currentTask callback does not expose task mutation tool', async () => {
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L0',
      scopedCallbacks: { currentTask: { taskId: 'test', updateStatus: async () => {} } },
    });
    assert.equal(findTool(tools, 'update_current_task_status'), undefined);
  });

  test('L1 with currentTask callback does expose task mutation tool', async () => {
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      scopedCallbacks: { currentTask: { taskId: 'test', updateStatus: async () => {} } },
    });
    assert.ok(findTool(tools, 'update_current_task_status'));
  });
});

// ── R12: task-status validation rejections must emit audit (AC-F13d) ──

describe('R12: update_current_task_status validation emits rejectWithAudit', () => {
  test('unsupported status emits outcome=rejected audit, zero callback mutations', async () => {
    const auditEvents = [];
    const mutations = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: (event) => auditEvents.push(event),
      scopedCallbacks: {
        currentTask: {
          invocationId: 'inv-r12',
          currentTaskId: 'task-r12',
          updateCurrentTaskStatus: async (patch) => mutations.push(patch),
        },
      },
    });
    const update = findTool(tools, 'update_current_task_status');
    assert.ok(update);
    await assert.rejects(() => update.execute({ status: 'paused' }), /Unsupported task status/);
    assert.equal(mutations.length, 0, 'callback must NOT be invoked');
    assert.equal(auditEvents.length, 1, 'must emit exactly one audit event');
    assert.equal(auditEvents[0].tool, 'update_current_task_status');
    assert.equal(auditEvents[0].outcome, 'rejected');
    assert.equal(auditEvents[0].invocationId, 'inv-r12');
    assert.equal(auditEvents[0].currentTaskId, 'task-r12');
    assert.ok(auditEvents[0].rejectReason.includes('paused'));
  });

  test('out-of-range progress emits outcome=rejected audit', async () => {
    const auditEvents = [];
    const mutations = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: (event) => auditEvents.push(event),
      scopedCallbacks: {
        currentTask: {
          invocationId: 'inv-r12b',
          currentTaskId: 'task-r12b',
          updateCurrentTaskStatus: async (patch) => mutations.push(patch),
        },
      },
    });
    const update = findTool(tools, 'update_current_task_status');
    await assert.rejects(() => update.execute({ progress: 150 }), /finite number between 0 and 100/);
    assert.equal(mutations.length, 0);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].outcome, 'rejected');
  });

  test('empty patch emits outcome=rejected audit', async () => {
    const auditEvents = [];
    const mutations = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: (event) => auditEvents.push(event),
      scopedCallbacks: {
        currentTask: {
          invocationId: 'inv-r12c',
          currentTaskId: 'task-r12c',
          updateCurrentTaskStatus: async (patch) => mutations.push(patch),
        },
      },
    });
    const update = findTool(tools, 'update_current_task_status');
    await assert.rejects(() => update.execute({}), /At least one of status, progress, or summary/);
    assert.equal(mutations.length, 0);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].outcome, 'rejected');
    assert.equal(auditEvents[0].invocationId, 'inv-r12c');
  });

  test('invalid summary emits outcome=rejected audit', async () => {
    const auditEvents = [];
    const mutations = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: (event) => auditEvents.push(event),
      scopedCallbacks: {
        currentTask: {
          invocationId: 'inv-r12d',
          currentTaskId: 'task-r12d',
          updateCurrentTaskStatus: async (patch) => mutations.push(patch),
        },
      },
    });
    const update = findTool(tools, 'update_current_task_status');
    await assert.rejects(() => update.execute({ summary: '' }), /1-500 characters/);
    assert.equal(mutations.length, 0);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].outcome, 'rejected');
  });
});

// ── R5: write_file target-type audit parity ──

describe('R5: write_file audits target-type rejections', () => {
  test('write_file at symlink target emits rejectWithAudit', async () => {
    const linkPath = join(tmpDir, 'r5-symlink');
    try {
      symlinkSync(join(outsideDir, 'target'), linkPath);
    } catch {
      /* already exists */
    }
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      audit: (evt) => auditEvents.push(evt),
    });
    const write = findTool(tools, 'write_file');
    assert.ok(write);
    await assert.rejects(
      () => write.execute({ path: 'r5-symlink', content: 'should not write' }),
      (err) => err.message.includes('symlink'),
    );
    // Must have audit record with outcome: 'rejected'
    const rejected = auditEvents.filter((e) => e.outcome === 'rejected');
    assert.ok(rejected.length > 0, 'symlink rejection must emit audit event');
    assert.equal(rejected[0].tool, 'write_file');
  });
});

// ── R6: family guard before Google gateway bypass ──

describe('R6: family guard runs before Google gateway bypass', () => {
  test('Google client + openai family profile → rejected by family guard', () => {
    const result = validateRuntimeProviderBinding('google', {
      id: 'test-google-account',
      authType: 'api_key',
      client: 'openai',
      baseUrl: 'https://third-party-gateway.example.com/v1',
    });
    assert.ok(result !== null, 'must reject family mismatch');
    assert.ok(result.includes('incompatible'), `expected incompatible error, got: ${result}`);
  });

  test('Google client + google family profile + third-party gateway → allowed', () => {
    const result = validateRuntimeProviderBinding('google', {
      id: 'test-google-account',
      authType: 'api_key',
      client: 'google',
      baseUrl: 'https://third-party-gateway.example.com/v1',
    });
    assert.equal(result, null);
  });
});

// ── R6+R7: empty/whitespace validation (allowEmpty) ──

describe('R6+R7: allowEmpty validation for write and patch schemas', () => {
  test('patch_file new_text="" passes validation (deletion)', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    assert.ok(patch);
    // Will fail at CAS check, not at validation — proving validation passed
    await assert.rejects(
      () => patch.execute({ path: 'existing.txt', old_text: 'hello', new_text: '', expected_hash: 'deadbeef' }),
      (err) => err.message.includes('expected_hash mismatch'),
    );
  });

  test('write_file content="" succeeds creating empty file', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const write = findTool(tools, 'write_file');
    assert.ok(write);
    const result = await write.execute({ path: 'r7-empty.txt', content: '' });
    assert.ok(result.includes('Wrote 0 bytes'));
  });

  test('patch_file old_text with whitespace-only passes validation', async () => {
    // Create a file with whitespace content
    writeFileSync(join(tmpDir, 'r7-ws.txt'), 'before\n  \nafter');
    const hash = sha256('before\n  \nafter');
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    assert.ok(patch);
    const result = await patch.execute({
      path: 'r7-ws.txt',
      old_text: '  \n',
      new_text: 'replaced\n',
      expected_hash: hash.slice(0, 8),
    });
    assert.ok(result.includes('Patched'));
  });
});

// ── R8: OpenAI tool calls without upstream IDs ──

describe('R8: OpenAI adapter suppresses tool calls without upstream IDs', () => {
  test('missing tool_call id emits stream_error and skips tool block', async () => {
    const adapter = new OpenAIChatAdapter();
    const chunks = [
      // tool_call delta without id
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: 'write_file', arguments: '{"path":"x"}' } }],
            },
          },
        ],
      })}\n\n`,
      // finish_reason
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const stream = toStream(chunks);
    const events = await collectStream(adapter.parseStreamEvents(stream));

    const streamErrors = events.filter((e) => e.type === 'stream_error');
    const toolBlocks = events.filter((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.ok(streamErrors.length > 0, 'must emit stream_error for missing id');
    assert.equal(toolBlocks.length, 0, 'must not emit tool_call block without id');
  });

  test('tool_call with valid id is emitted normally', async () => {
    const adapter = new OpenAIChatAdapter();
    const chunks = [
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"path":"x"}' } }],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const stream = toStream(chunks);
    const events = await collectStream(adapter.parseStreamEvents(stream));

    const toolBlocks = events.filter((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.equal(toolBlocks.length, 1);
    assert.equal(toolBlocks[0].block.id, 'call_abc');
  });
});

// ── R9: Anthropic tool_use blocks without upstream IDs ──

describe('R9: Anthropic parser suppresses tool_use blocks without upstream IDs', () => {
  test('tool_use with empty id emits stream_error', async () => {
    const stream = toStream([
      sseEvent({ type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 1 } } }),
      // content_block_start with NO id field
      sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'write_file' } }),
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' },
      }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
      sseEvent({ type: 'message_stop' }),
    ]);
    const events = await collectStream(parseAnthropicSSE(stream));

    const streamErrors = events.filter((e) => e.type === 'stream_error');
    const toolBlocks = events.filter((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.ok(streamErrors.length > 0, 'must emit stream_error for missing tool_use id');
    assert.equal(toolBlocks.length, 0, 'must not emit tool_call block without id');
  });
});

// ── R10: non-object Anthropic tool input normalization ──

describe('R10: non-object tool input normalized to sentinel', () => {
  test('null tool input becomes { _error } sentinel', async () => {
    const stream = toStream([
      sseEvent({ type: 'message_start', message: { id: 'msg-2', usage: { input_tokens: 1 } } }),
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_r10', name: 'test_tool' },
      }),
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'null' } }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
      sseEvent({ type: 'message_stop' }),
    ]);
    const events = await collectStream(parseAnthropicSSE(stream));
    const toolBlock = events.find((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.ok(toolBlock, 'tool_call block should be emitted (id is valid)');
    assert.equal(toolBlock.block.input._error, 'Non-object tool input');
  });

  test('array tool input becomes { _error } sentinel', async () => {
    const stream = toStream([
      sseEvent({ type: 'message_start', message: { id: 'msg-3', usage: { input_tokens: 1 } } }),
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_r10b', name: 'test_tool' },
      }),
      sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[1,2]' } }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }),
      sseEvent({ type: 'message_stop' }),
    ]);
    const events = await collectStream(parseAnthropicSSE(stream));
    const toolBlock = events.find((e) => e.type === 'content_block_complete' && e.block?.type === 'tool_call');
    assert.ok(toolBlock);
    assert.equal(toolBlock.block.input._error, 'Non-object tool input');
  });
});

// ── R11: isToolUseStopReason adapter predicates ──

describe('R11: isToolUseStopReason adapter predicates', () => {
  test('Anthropic: tool_use → true, others → false', () => {
    const adapter = new AnthropicMessagesAdapter();
    assert.equal(adapter.isToolUseStopReason('tool_use'), true);
    assert.equal(adapter.isToolUseStopReason('end_turn'), false);
    assert.equal(adapter.isToolUseStopReason('max_tokens'), false);
    assert.equal(adapter.isToolUseStopReason('pause_turn'), false);
    assert.equal(adapter.isToolUseStopReason('future_reason'), false);
    assert.equal(adapter.isToolUseStopReason(null), false);
  });

  test('OpenAI: tool_calls → true, others → false', () => {
    const adapter = new OpenAIChatAdapter();
    assert.equal(adapter.isToolUseStopReason('tool_calls'), true);
    assert.equal(adapter.isToolUseStopReason('stop'), false);
    assert.equal(adapter.isToolUseStopReason('length'), false);
    assert.equal(adapter.isToolUseStopReason('future_reason'), false);
    assert.equal(adapter.isToolUseStopReason(null), false);
  });
});

// ── R11 service-level: non-tool-use stop_reason suppresses tool execution ──

describe('R11 service-level: CatAgentService suppresses tools on non-tool-use stop_reason', () => {
  let prevFetch;
  let prevEnv;
  let prevModel;

  before(() => {
    prevFetch = globalThis.fetch;
    prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    prevModel = process.env.CAT_OPUS_MODEL;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    process.env.CAT_OPUS_MODEL = 'claude-opus-4-6';
    resetMigrationState();
  });

  after(() => {
    globalThis.fetch = prevFetch;
    if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
    else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    if (prevModel !== undefined) process.env.CAT_OPUS_MODEL = prevModel;
    else delete process.env.CAT_OPUS_MODEL;
    resetMigrationState();
  });

  test('pause_turn + tool block → tool NOT executed, error result emitted, no second turn', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      // Stream delivers a tool_use block but stop_reason is 'pause_turn' (not 'tool_use')
      const events = [
        sseEvent({ type: 'message_start', message: { id: 'msg-r11', usage: { input_tokens: 10 } } }),
        sseEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu-r11', name: 'read_file' },
        }),
        sseEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"existing.txt"}' },
        }),
        sseEvent({ type: 'content_block_stop', index: 0 }),
        sseEvent({ type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } }),
        sseEvent({ type: 'message_stop' }),
      ].join('');
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(events));
            controller.close();
          },
        }),
      };
    };

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-ant' },
    });
    const msgs = [];
    for await (const msg of svc.invoke('test', { workingDirectory: tmpDir })) {
      msgs.push(msg);
    }

    // Only one fetch call — no second turn initiated
    assert.equal(fetchCallCount, 1, 'must NOT initiate a second API call');

    // Tool result with error status emitted (suppression message)
    const toolResult = msgs.find((m) => m.type === 'tool_result');
    assert.ok(toolResult, 'tool_result event must be emitted');
    assert.equal(toolResult.toolResultStatus, 'error');
    assert.ok(toolResult.content.includes('pause_turn'), 'error mentions the non-tool-use stop reason');
    assert.ok(toolResult.content.includes('suppressed'), 'error mentions suppression');

    // Done event present
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done event must be emitted');
  });

  test('future_reason + tool block → same suppression behavior', async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      const events = [
        sseEvent({ type: 'message_start', message: { id: 'msg-r11b', usage: { input_tokens: 10 } } }),
        sseEvent({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu-r11b', name: 'list_files' },
        }),
        sseEvent({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"."}' },
        }),
        sseEvent({ type: 'content_block_stop', index: 0 }),
        sseEvent({ type: 'message_delta', delta: { stop_reason: 'future_reason' }, usage: { output_tokens: 5 } }),
        sseEvent({ type: 'message_stop' }),
      ].join('');
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(events));
            controller.close();
          },
        }),
      };
    };

    const svc = new CatAgentService({
      catId: 'opus',
      projectRoot: tmpDir,
      catConfig: { accountRef: 'test-ant' },
    });
    const msgs = [];
    for await (const msg of svc.invoke('test', { workingDirectory: tmpDir })) {
      msgs.push(msg);
    }

    assert.equal(fetchCallCount, 1, 'must NOT initiate a second API call');
    const toolResult = msgs.find((m) => m.type === 'tool_result');
    assert.ok(toolResult, 'tool_result event must be emitted');
    assert.equal(toolResult.toolResultStatus, 'error');
    assert.ok(toolResult.content.includes('future_reason'));
    assert.ok(toolResult.content.includes('suppressed'));
  });
});

// ── .cat-cafe boundary: tool-level negative regressions (Sol re-review requirement) ──

describe('.cat-cafe boundary: all 5 tool operations reject with correct audit', () => {
  test('read_file refuses .cat-cafe paths', async () => {
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L0',
      audit: (evt) => auditEvents.push(evt),
    });
    const read = findTool(tools, 'read_file');
    assert.ok(read);
    await assert.rejects(
      () => read.execute({ path: '.cat-cafe/credentials.json' }),
      (err) => err.message.includes('.cat-cafe') || err.message.includes('Access denied'),
    );
  });

  test('list_files refuses .cat-cafe directory', async () => {
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L0',
      audit: (evt) => auditEvents.push(evt),
    });
    const list = findTool(tools, 'list_files');
    assert.ok(list);
    await assert.rejects(
      () => list.execute({ path: '.cat-cafe' }),
      (err) => err.message.includes('.cat-cafe') || err.message.includes('Access denied'),
    );
  });

  test('search_content refuses .cat-cafe search path', async (t) => {
    // Reset rg detection cache — ensures fresh PATH check per test run.
    resetRgCache();
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L0',
      audit: (evt) => auditEvents.push(evt),
    });
    const search = findTool(tools, 'search_content');
    if (!search) {
      // rg (ripgrep) not on PATH — explicitly report as skipped so CI
      // shows the lost coverage rather than a false green.
      t.skip('ripgrep (rg) not available — search_content not registered');
      return;
    }
    await assert.rejects(
      () => search.execute({ pattern: 'secret', path: '.cat-cafe' }),
      (err) => err.message.includes('.cat-cafe') || err.message.includes('Access denied'),
    );
  });

  test('write_file refuses .cat-cafe path + emits outcome=rejected audit', async () => {
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      audit: (evt) => auditEvents.push(evt),
    });
    const write = findTool(tools, 'write_file');
    assert.ok(write);
    await assert.rejects(
      () => write.execute({ path: '.cat-cafe/pwned.txt', content: 'should not write' }),
      (err) => err.message.includes('.cat-cafe') || err.message.includes('Access denied'),
    );
    // write_file's resolveCreatePathAudited emits a rejected audit event
    const rejected = auditEvents.filter((e) => e.outcome === 'rejected');
    assert.ok(rejected.length > 0, 'write_file to .cat-cafe must emit rejected audit event');
    assert.equal(rejected[0].tool, 'write_file');
  });

  test('patch_file refuses .cat-cafe path + emits outcome=rejected audit', async () => {
    const auditEvents = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      audit: (evt) => auditEvents.push(evt),
    });
    const patch = findTool(tools, 'patch_file');
    assert.ok(patch);
    await assert.rejects(
      () =>
        patch.execute({
          path: '.cat-cafe/cat-catalog.json',
          old_text: '"role"',
          new_text: '"pwned"',
          expected_hash: 'deadbeef',
        }),
      (err) => err.message.includes('.cat-cafe') || err.message.includes('Access denied'),
    );
    const rejected = auditEvents.filter((e) => e.outcome === 'rejected');
    assert.ok(rejected.length > 0, 'patch_file to .cat-cafe must emit rejected audit event');
    assert.equal(rejected[0].tool, 'patch_file');
  });

  // Verify data/ paths are NOT blocked (regression guard for the overbroad rule removal)
  test('read_file allows data/ paths (no segment-wide denylist)', async () => {
    writeFileSync(join(tmpDir, 'data-fixture.txt'), 'allowed content');
    mkdirSync(join(tmpDir, 'src', 'data'), { recursive: true });
    writeFileSync(join(tmpDir, 'src', 'data', 'input.json'), '{"test": true}');

    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L0' });
    const read = findTool(tools, 'read_file');
    // src/data/input.json must be readable (previously blocked by overbroad 'data' rule)
    const result = await read.execute({ path: 'src/data/input.json' });
    assert.ok(result.includes('"test"'), 'src/data/input.json must be readable');
  });
});

// ── Protected workspace root: buildToolRegistry refuses protected roots ──

describe('Protected workspace root: buildToolRegistry refuses .cat-cafe roots', () => {
  test('.cat-cafe as workspace root → zero tools registered', async () => {
    const protectedRoot = join(tmpDir, '.cat-cafe');
    mkdirSync(protectedRoot, { recursive: true });
    const auditEvents = [];
    const tools = await buildToolRegistry(protectedRoot, {
      nativeToolLevel: 'L1',
      audit: (evt) => auditEvents.push(evt),
    });
    assert.equal(tools.length, 0, 'no tools should be registered for a protected root');
    const rejected = auditEvents.filter((e) => e.outcome === 'rejected');
    assert.ok(rejected.length > 0, 'must emit rejected audit for protected workspace root');
    assert.ok(rejected[0].rejectReason.includes('.cat-cafe'));
  });

  test('.git as workspace root → zero tools registered', async () => {
    const protectedRoot = join(tmpDir, '.git');
    mkdirSync(protectedRoot, { recursive: true });
    const tools = await buildToolRegistry(protectedRoot, { nativeToolLevel: 'L1' });
    assert.equal(tools.length, 0, 'no tools should be registered for a .git root');
  });

  test('normal workspace root with .cat-cafe descendant → tools registered', async () => {
    // The workspace root itself is clean — descendant .cat-cafe is handled by denylist
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    assert.ok(tools.length > 0, 'normal workspace root should have tools registered');
  });

  test('subdirectory of .cat-cafe as workspace root → zero tools', async () => {
    const nestedProtected = join(tmpDir, '.cat-cafe', 'subdir');
    mkdirSync(nestedProtected, { recursive: true });
    const tools = await buildToolRegistry(nestedProtected, { nativeToolLevel: 'L1' });
    assert.equal(tools.length, 0, 'subdirectory of protected root should have zero tools');
  });
});
