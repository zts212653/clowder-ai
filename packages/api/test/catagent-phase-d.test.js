/**
 * CatAgent Phase D Tests — Read-Only Tools + Agentic Loop (AC-D1 ~ AC-D2)
 *
 * AC-D1: read_file / list_files / search_content with security boundaries
 * AC-D2: agentic loop — tool_use → execute → tool_result → re-call until terminal
 *
 * Uses temp directories and mock fetch to avoid real API/filesystem side effects.
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { buildToolRegistry, findTool, getToolSchemas, resetRgCache } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-read-tools.js'
);
const { CatAgentService } = await import('../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js');
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

// ── Helpers ──

async function collect(iter) {
  const msgs = [];
  for await (const msg of iter) msgs.push(msg);
  return msgs;
}

// ── Temp workspace setup ──

let tmpDir;
let catCafeDir;

before(() => {
  tmpDir = join(tmpdir(), `catagent-d-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  // Create workspace files
  writeFileSync(join(tmpDir, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  writeFileSync(join(tmpDir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'));
  // Oversized file (>1 MiB) for bounded-read test — each line ~100 bytes × 12000 ≈ 1.2 MB
  writeFileSync(
    join(tmpDir, 'huge.log'),
    Array.from({ length: 12_000 }, (_, i) => `[LOG] entry ${String(i + 1).padStart(5, '0')} ${'x'.repeat(80)}`).join(
      '\n',
    ),
  );
  mkdirSync(join(tmpDir, 'src'), { recursive: true });
  writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const VERSION = "1.0";\nconsole.log(VERSION);\n');
  writeFileSync(join(tmpDir, 'src', 'config.ts'), 'export const PORT = 3000;\n');

  // Denylist files (should be filtered)
  writeFileSync(join(tmpDir, '.env'), 'SECRET=abc');
  writeFileSync(join(tmpDir, '.env.local'), 'LOCAL_SECRET=xyz');
  mkdirSync(join(tmpDir, 'secrets'), { recursive: true });
  writeFileSync(join(tmpDir, 'secrets', 'key.json'), '{"key":"hidden"}');
  mkdirSync(join(tmpDir, '.git'), { recursive: true });
  writeFileSync(join(tmpDir, '.git', 'config'), '[core]');

  // Credential fixtures for service-level tests
  catCafeDir = join(tmpDir, '.cat-cafe');
  mkdirSync(catCafeDir, { recursive: true });
  writeFileSync(join(catCafeDir, 'accounts.json'), JSON.stringify({ 'test-ant': { authType: 'api_key' } }));
  writeFileSync(join(catCafeDir, 'credentials.json'), JSON.stringify({ 'test-ant': { apiKey: 'sk-test-d' } }));
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  resetRgCache();
});

// ── AC-D1: Tool registry ──

describe('D1: tool registry', () => {
  test('buildToolRegistry returns read_file + list_files (+ search_content if rg available)', async () => {
    const tools = await buildToolRegistry(tmpDir);
    assert.ok(tools.length >= 2, 'at least read_file + list_files');
    assert.ok(findTool(tools, 'read_file'), 'has read_file');
    assert.ok(findTool(tools, 'list_files'), 'has list_files');
  });

  test('getToolSchemas returns Anthropic-compatible schemas', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const schemas = getToolSchemas(tools);
    for (const s of schemas) {
      assert.ok(s.name, 'has name');
      assert.ok(s.description, 'has description');
      assert.equal(s.input_schema.type, 'object', 'schema type is object');
    }
  });
});

// ── AC-D1: read_file ──

describe('D1: read_file', () => {
  test('reads a small file completely', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    const result = await tool.execute({ path: 'hello.txt' });
    assert.ok(result.includes('line1'), 'contains first line');
    assert.ok(result.includes('line5'), 'contains last line');
    assert.ok(!result.includes('Truncated'), 'not truncated');
  });

  test('truncates large files at default limit', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    const result = await tool.execute({ path: 'big.txt' });
    assert.ok(result.includes('[Truncated'), 'has truncation notice');
    assert.ok(result.includes('line 1'), 'contains first line');
  });

  test('supports start_line/end_line for targeted reads', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    const result = await tool.execute({ path: 'big.txt', start_line: 10, end_line: 20 });
    assert.ok(result.includes('line 10'), 'starts at line 10');
    assert.ok(result.includes('line 20'), 'ends at line 20');
    assert.ok(!result.includes('line 9'), 'does not include line 9');
    assert.ok(!result.includes('Truncated'), 'not truncated for small range');
  });

  test('rejects path traversal', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    await assert.rejects(() => tool.execute({ path: '../../../etc/passwd' }), /outside workspace|TRAVERSAL/i);
  });

  test('rejects denylisted files', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    await assert.rejects(() => tool.execute({ path: '.env' }), /denied/i);
    await assert.rejects(() => tool.execute({ path: '.env.local' }), /denied/i);
    await assert.rejects(() => tool.execute({ path: 'secrets/key.json' }), /denied/i);
    await assert.rejects(() => tool.execute({ path: '.git/config' }), /denied/i);
  });

  test('rejects symlink aliasing a denylisted target (P1 regression)', async () => {
    // Create symlink: safe-alias -> .env (inside workspace, passes name check but target is denied)
    const symlinkPath = join(tmpDir, 'safe-alias');
    try {
      symlinkSync(join(tmpDir, '.env'), symlinkPath);
    } catch {
      // symlink already exists from prior run — fine
    }
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    await assert.rejects(() => tool.execute({ path: 'safe-alias' }), /denied/i);
  });

  test('oversized file is bounded-read without OOM (P1 read budget)', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'read_file');
    const result = await tool.execute({ path: 'huge.log' });
    assert.ok(result.includes('[Truncated'), 'truncated');
    assert.ok(result.includes('1 MiB read budget'), 'mentions read budget');
    assert.ok(result.includes('[LOG] entry 00001'), 'contains first line');
    // Content should be bounded — well under 1 MiB after line/byte truncation
    assert.ok(Buffer.byteLength(result) < 100_000, 'output is bounded');
  });
});

// ── AC-D1: list_files ──

describe('D1: list_files', () => {
  test('lists directory contents', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'list_files');
    const result = await tool.execute({});
    assert.ok(result.includes('hello.txt'), 'shows hello.txt');
    assert.ok(result.includes('src'), 'shows src directory');
  });

  test('filters denylisted entries', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'list_files');
    const result = await tool.execute({});
    assert.ok(!result.includes('.env'), 'hides .env');
    assert.ok(!result.includes('secrets'), 'hides secrets');
    assert.ok(!result.includes('.git'), 'hides .git');
  });

  test('lists subdirectory', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'list_files');
    const result = await tool.execute({ path: 'src' });
    assert.ok(result.includes('index.ts'), 'shows index.ts');
    assert.ok(result.includes('config.ts'), 'shows config.ts');
  });

  test('rejects path traversal', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'list_files');
    await assert.rejects(() => tool.execute({ path: '../..' }), /outside workspace|TRAVERSAL/i);
  });
});

// ── AC-D1: search_content ──

describe('D1: search_content', () => {
  test('finds matching content', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'search_content');
    if (!tool) return; // rg not available
    const result = await tool.execute({ pattern: 'VERSION' });
    assert.ok(result.includes('VERSION'), 'finds VERSION in results');
    assert.ok(result.includes('index.ts'), 'shows filename');
  });

  test('returns no matches gracefully', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'search_content');
    if (!tool) return;
    const result = await tool.execute({ pattern: 'NONEXISTENT_STRING_XYZ' });
    assert.ok(result.includes('No matches'), 'reports no matches');
  });

  test('respects include glob', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'search_content');
    if (!tool) return;
    const result = await tool.execute({ pattern: 'export', include: '*.ts' });
    assert.ok(result.includes('export'), 'finds export');
  });

  test('filters denylisted files from results', async () => {
    const tools = await buildToolRegistry(tmpDir);
    const tool = findTool(tools, 'search_content');
    if (!tool) return;
    // .env contains SECRET, but results should be filtered
    const result = await tool.execute({ pattern: 'SECRET' });
    assert.ok(!result.includes('.env'), 'does not show .env matches');
  });
});

// ── AC-D2: Agentic loop (service-level tests with mock fetch) ──

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function jsonResponseToSSE(resp) {
  let sse = '';
  sse += sseEvent({
    type: 'message_start',
    message: { id: resp.id, usage: { input_tokens: resp.usage?.input_tokens ?? 0 } },
  });
  for (let i = 0; i < resp.content.length; i++) {
    const block = resp.content[i];
    if (block.type === 'text') {
      sse += sseEvent({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      sse += sseEvent({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
      sse += sseEvent({ type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      sse += sseEvent({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      });
      sse += sseEvent({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      sse += sseEvent({ type: 'content_block_stop', index: i });
    }
  }
  sse += sseEvent({
    type: 'message_delta',
    delta: { stop_reason: resp.stop_reason },
    usage: { output_tokens: resp.usage?.output_tokens ?? 0 },
  });
  sse += sseEvent({ type: 'message_stop' });
  return sse;
}

function mockSseResponse(resp) {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: sseStream(jsonResponseToSSE(resp)),
  };
}

function mockAnthropicApi(responses) {
  let callIndex = 0;
  return async (_url, _init) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1];
    callIndex++;
    return mockSseResponse(resp);
  };
}

describe('D2: agentic loop', () => {
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

  test('single-turn text (no tools) still works', async () => {
    globalThis.fetch = mockAnthropicApi([
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('hi'));
    assert.equal(msgs[0].type, 'session_init');
    assert.equal(msgs[1].type, 'text');
    assert.equal(msgs[1].content, 'Hello');
    assert.equal(msgs[2].type, 'done');
    assert.ok(msgs[2].metadata.usage.inputTokens > 0);
  });

  test('multi-turn: tool_use → tool_result → text → done', async () => {
    globalThis.fetch = mockAnthropicApi([
      // Turn 1: model requests read_file
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'hello.txt' } }],
        usage: { input_tokens: 20, output_tokens: 15 },
      },
      // Turn 2: model responds with text after seeing tool result
      {
        id: 'msg2',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The file has 5 lines' }],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('read hello.txt', { workingDirectory: tmpDir }));

    // Should have: session_init, tool_use, tool_result, text, done
    const types = msgs.map((m) => m.type);
    assert.ok(types.includes('session_init'), 'has session_init');
    assert.ok(types.includes('tool_use'), 'has tool_use (yielded to upstream)');
    assert.ok(types.includes('tool_result'), 'has tool_result digest');
    assert.ok(types.includes('text'), 'has text response');
    assert.ok(types.includes('done'), 'has done');

    // Usage should be accumulated across both turns
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done.metadata.usage.inputTokens >= 70, `accumulated input tokens: ${done.metadata.usage.inputTokens}`);
    assert.ok(done.metadata.usage.outputTokens >= 25, `accumulated output tokens: ${done.metadata.usage.outputTokens}`);

    // tool_result should have truncated content
    const toolResult = msgs.find((m) => m.type === 'tool_result');
    assert.ok(toolResult.content.length <= 500, 'tool_result digest is truncated');
    assert.equal(toolResult.toolName, 'read_file');
  });

  test('tool_use events preserve metadata for audit chain', async () => {
    globalThis.fetch = mockAnthropicApi([
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 'list_files', input: {} }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        id: 'msg2',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Listed files' }],
        usage: { input_tokens: 30, output_tokens: 5 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('list files', { workingDirectory: tmpDir }));

    const toolUse = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolUse.metadata, 'tool_use has metadata');
    assert.equal(toolUse.metadata.provider, 'catagent');
    assert.ok(toolUse.metadata.sessionId, 'tool_use has sessionId');
  });

  test('unknown tool name returns error in tool_result', async () => {
    globalThis.fetch = mockAnthropicApi([
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 'write_file', input: { path: 'x', content: 'y' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        id: 'msg2',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('write', { workingDirectory: tmpDir }));

    const toolResult = msgs.find((m) => m.type === 'tool_result');
    assert.ok(toolResult.content.includes('Error'), 'tool_result contains error for unknown tool');
    assert.ok(toolResult.content.includes('write_file'), 'mentions the tool name');
  });

  test('tools not sent when no workingDirectory', async () => {
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSseResponse({
        id: 'msg',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'no tools' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    await collect(svc.invoke('test'));

    assert.ok(capturedBody, 'request was made');
    assert.equal(capturedBody.tools, undefined, 'no tools when no workingDirectory');
  });

  test('tools ARE sent when workingDirectory provided', async () => {
    let capturedBody = null;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockSseResponse({
        id: 'msg',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'with tools' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    await collect(svc.invoke('test', { workingDirectory: tmpDir }));

    assert.ok(capturedBody, 'request was made');
    assert.ok(Array.isArray(capturedBody.tools), 'tools array present');
    assert.ok(capturedBody.tools.length >= 2, 'at least read_file + list_files');
    assert.ok(
      capturedBody.tools.some((t) => t.name === 'read_file'),
      'includes read_file',
    );
  });

  test('done event only emitted once even after tool loop', async () => {
    globalThis.fetch = mockAnthropicApi([
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'hello.txt' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      {
        id: 'msg2',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 30, output_tokens: 5 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test', { workingDirectory: tmpDir }));

    const doneCount = msgs.filter((m) => m.type === 'done').length;
    assert.equal(doneCount, 1, 'exactly one done event');
  });

  test('non-terminal stop_reason with no tool blocks emits distinct error (P2 regression)', async () => {
    globalThis.fetch = mockAnthropicApi([
      {
        id: 'msg1',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: 'Pausing...' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test', { workingDirectory: tmpDir }));

    const error = msgs.find((m) => m.type === 'error');
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(error, 'has error event');
    assert.ok(done, 'has done event');
    // Must NOT say "loop exceeded" — should mention the actual stop_reason
    assert.ok(!error.error.includes('loop exceeded'), 'not a loop overflow error');
    assert.ok(error.error.includes('pause_turn'), 'mentions the actual stop_reason');
    assert.ok(error.error.includes('non-terminal'), 'describes it as non-terminal');
  });

  test('API error during tool loop still produces error + done', async () => {
    let callCount = 0;
    globalThis.fetch = async (_url, _init) => {
      callCount++;
      if (callCount === 1) {
        return mockSseResponse({
          id: 'msg1',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'hello.txt' } }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      // Second call fails
      return { ok: false, status: 500, text: async () => 'Internal server error' };
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test', { workingDirectory: tmpDir }));

    const error = msgs.find((m) => m.type === 'error');
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(error, 'has error event');
    assert.ok(done, 'has done event (no dangle)');
  });

  test('loop overflow fires after exactly MAX_TOOL_TURNS (P3 off-by-one regression)', async () => {
    // Every call returns tool_use — loop should overflow at exactly 15 turns
    let callCount = 0;
    globalThis.fetch = async (_url, _init) => {
      callCount++;
      return mockSseResponse({
        id: `msg${callCount}`,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `tu${callCount}`, name: 'read_file', input: { path: 'hello.txt' } }],
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test', { workingDirectory: tmpDir }));

    const error = msgs.find((m) => m.type === 'error' && m.error.includes('loop exceeded'));
    assert.ok(error, 'overflow error emitted');
    // MAX_TOOL_TURNS = 15, so exactly 15 API calls (turns 0..14)
    assert.equal(callCount, 15, `expected 15 API calls, got ${callCount}`);
  });

  test('first-turn API error preserves zero usage in done (usage regression)', async () => {
    globalThis.fetch = async (_url, _init) => {
      return { ok: false, status: 503, text: async () => 'Service unavailable' };
    };

    const svc = new CatAgentService({ catId: 'opus', projectRoot: tmpDir, catConfig: { accountRef: 'test-ant' } });
    const msgs = await collect(svc.invoke('test'));

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'has done event');
    assert.ok(done.metadata.usage, 'done.metadata.usage is not undefined');
    assert.equal(done.metadata.usage.inputTokens, 0, 'zero input tokens');
    assert.equal(done.metadata.usage.outputTokens, 0, 'zero output tokens');
  });
});
