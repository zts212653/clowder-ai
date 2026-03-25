/**
 * codex-event-transform pure function tests
 * F045: NDJSON 可观测性 — Codex parser 补全
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { transformCodexEvent } = await import('../dist/domains/cats/services/agents/providers/codex-event-transform.js');

const CAT = 'codex';

// ── Existing behaviour (regression guard) ──

test('thread.started → session_init', () => {
  const msg = transformCodexEvent({ type: 'thread.started', thread_id: 'th-1' }, CAT);
  assert.equal(msg?.type, 'session_init');
  assert.equal(msg?.sessionId, 'th-1');
});

test('item.completed agent_message → text', () => {
  const msg = transformCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello' } }, CAT);
  assert.equal(msg?.type, 'text');
  assert.equal(msg?.content, 'Hello');
});

test('item.started command_execution → tool_use', () => {
  const msg = transformCodexEvent(
    { type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } },
    CAT,
  );
  assert.equal(msg?.type, 'tool_use');
  assert.equal(msg?.toolName, 'command_execution');
  assert.deepEqual(msg?.toolInput, { command: 'ls -la' });
});

test('item.completed command_execution → tool_result', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'ls',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'file.txt',
      },
    },
    CAT,
  );
  assert.equal(msg?.type, 'tool_result');
  assert.ok(msg?.content?.includes('file.txt'));
});

test('item.completed file_change → tool_use', () => {
  const msg = transformCodexEvent(
    {
      type: 'item.completed',
      item: { type: 'file_change', status: 'completed', changes: ['a', 'b'] },
    },
    CAT,
  );
  assert.equal(msg?.type, 'tool_use');
  assert.equal(msg?.toolName, 'file_change');
});

test('Reconnecting error → system_info', () => {
  const msg = transformCodexEvent({ type: 'error', message: 'Reconnecting... (attempt 1)' }, CAT);
  assert.equal(msg?.type, 'system_info');
  assert.ok(msg?.content?.startsWith('Reconnecting...'));
});

test('unknown event type → null', () => {
  assert.equal(transformCodexEvent({ type: 'turn.started' }, CAT), null);
});

// ── F045: todo_list → system_info(task_progress) ──

test('item.started todo_list → system_info(task_progress) with initial tasks', () => {
  const event = {
    type: 'item.started',
    item: {
      type: 'todo_list',
      todo_items: [
        { id: 't1', content: 'Read the file', status: 'in_progress' },
        { id: 't2', content: 'Write the test', status: 'pending' },
      ],
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'task_progress');
  assert.equal(payload.tasks.length, 2);
  assert.equal(payload.tasks[0].subject, 'Read the file');
  assert.equal(payload.tasks[0].status, 'in_progress');
});

test('item.started todo_list (new schema: items/text/completed) → system_info(task_progress)', () => {
  const event = {
    type: 'item.started',
    item: {
      type: 'todo_list',
      items: [
        { text: 'Todo 1: Verify todo workflow', completed: false },
        { text: 'Todo 2: Leave as pending sample', completed: true },
      ],
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'task_progress');
  assert.equal(payload.tasks.length, 2);
  assert.equal(payload.tasks[0].subject, 'Todo 1: Verify todo workflow');
  assert.equal(payload.tasks[0].status, 'pending');
  assert.equal(payload.tasks[1].subject, 'Todo 2: Leave as pending sample');
  assert.equal(payload.tasks[1].status, 'completed');
});

test('item.updated todo_list → system_info(task_progress) with updated tasks', () => {
  const event = {
    type: 'item.updated',
    item: {
      type: 'todo_list',
      todo_items: [
        { id: 't1', content: 'Read the file', status: 'completed' },
        { id: 't2', content: 'Write the test', status: 'in_progress' },
      ],
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'task_progress');
  assert.equal(payload.tasks[0].status, 'completed');
  assert.equal(payload.tasks[1].status, 'in_progress');
});

test('item.completed todo_list → system_info(task_progress) all done', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'todo_list',
      todo_items: [
        { id: 't1', content: 'Read the file', status: 'completed' },
        { id: 't2', content: 'Write the test', status: 'completed' },
      ],
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(
    payload.tasks.every((t) => t.status === 'completed'),
    true,
  );
});

test('todo_list with empty items → system_info with tasks:[] (clears UI)', () => {
  const event = {
    type: 'item.started',
    item: { type: 'todo_list', todo_items: [] },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.ok(msg !== null, 'empty todo_list should emit snapshot to clear UI');
  assert.equal(msg.type, 'system_info');
  const payload = JSON.parse(msg.content);
  assert.equal(payload.type, 'task_progress');
  assert.deepEqual(payload.tasks, []);
});

// ── F045: reasoning → system_info(thinking) ──

test('item.completed reasoning → system_info(thinking)', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'reasoning',
      text: 'Let me think about this...\nThe user wants X.',
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'thinking');
  assert.equal(payload.text, 'Let me think about this...\nThe user wants X.');
});

test('reasoning with empty text → null', () => {
  const event = {
    type: 'item.completed',
    item: { type: 'reasoning', text: '' },
  };
  assert.equal(transformCodexEvent(event, CAT), null);
});

// ── F045: mcp_tool_call → tool_use/tool_result ──

test('item.started mcp_tool_call → tool_use', () => {
  const event = {
    type: 'item.started',
    item: {
      type: 'mcp_tool_call',
      server: 'cat-cafe',
      tool: 'post_message',
      arguments: { text: 'hello' },
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'tool_use');
  assert.equal(msg?.toolName, 'mcp:cat-cafe/post_message');
  assert.deepEqual(msg?.toolInput, { text: 'hello' });
});

test('item.completed mcp_tool_call → tool_result', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'cat-cafe',
      tool: 'post_message',
      status: 'completed',
      result: { content: [{ type: 'text', text: 'ok' }] },
    },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'tool_result');
  assert.ok(msg?.content?.includes('mcp:cat-cafe/post_message'));
});

// ── F045: web_search → system_info(web_search) ──

test('item.completed web_search → system_info(web_search)', () => {
  const event = {
    type: 'item.completed',
    item: { type: 'web_search', query: 'Node.js streams' },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'web_search');
  // query should NOT be stored (privacy)
  assert.equal(payload.query, undefined);
  assert.equal(payload.count, 1);
});

// ── F045: item-level error → system_info(warning) ──

test('item.completed error → system_info(warning)', () => {
  const event = {
    type: 'item.completed',
    item: { type: 'error', message: 'command output truncated' },
  };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg?.type, 'system_info');
  const payload = JSON.parse(msg?.content ?? '{}');
  assert.equal(payload.type, 'warning');
  assert.equal(payload.message, 'command output truncated');
});

// ── F045: top-level error (non-Reconnecting) → null ──
// Non-Reconnecting errors return null from the transform.
// CodexAgentService collects them via collectCodexStreamError() and surfaces
// them as diagnostics in the exit error (withRecentDiagnostics).

test('top-level error without Reconnecting → null (handled by service)', () => {
  const event = { type: 'error', message: 'Fatal: connection lost' };
  const msg = transformCodexEvent(event, CAT);
  assert.equal(msg, null);
});

// ── F060: mcp_tool_call with output_image → tool_result + rich_block ──

test('mcp_tool_call with image → returns array [tool_result, system_info(rich_block)]', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'xiaohongshu',
      tool: 'get_login_qrcode',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'QR code generated' },
          {
            type: 'image',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            mimeType: 'image/png',
          },
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(Array.isArray(result), 'should return array when image blocks present');
  assert.equal(result.length, 2);

  // First: normal tool_result (text parts only)
  assert.equal(result[0].type, 'tool_result');
  assert.ok(result[0].content.includes('QR code generated'));

  // Second: system_info with rich_block payload
  assert.equal(result[1].type, 'system_info');
  const payload = JSON.parse(result[1].content);
  assert.equal(payload.type, 'rich_block');
  assert.equal(payload.block.kind, 'media_gallery');
  assert.equal(payload.block.v, 1);
  assert.equal(payload.block.items.length, 1);
  assert.ok(payload.block.items[0].url.startsWith('data:image/png;base64,'));
  assert.equal(payload.block.title, 'mcp:xiaohongshu/get_login_qrcode');
});

test('mcp_tool_call with multiple images → gallery has multiple items', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'screenshots',
      tool: 'capture',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'Captured 2 screenshots' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(Array.isArray(result));
  const richMsg = result[1];
  const payload = JSON.parse(richMsg.content);
  assert.equal(payload.block.items.length, 2);
  assert.ok(payload.block.items[0].url.startsWith('data:image/png;base64,'));
  assert.ok(payload.block.items[1].url.startsWith('data:image/jpeg;base64,'));
});

test('mcp_tool_call with only text (no images) → single tool_result (unchanged)', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_file',
      status: 'completed',
      result: { content: [{ type: 'text', text: 'file contents' }] },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(!Array.isArray(result), 'no images → single message, not array');
  assert.equal(result.type, 'tool_result');
  assert.ok(result.content.includes('file contents'));
});

test('mcp_tool_call image without mimeType → gracefully skipped', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'broken',
      tool: 'bad_image',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'some text' },
          { type: 'image', data: 'AAAA' }, // no mimeType
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  // Without valid mimeType, image block should be skipped → single tool_result
  assert.ok(!Array.isArray(result), 'invalid image → single message');
  assert.equal(result.type, 'tool_result');
});

test('mcp_tool_call image without data → gracefully skipped', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'broken',
      tool: 'no_data',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'some text' },
          { type: 'image', mimeType: 'image/png' }, // no data
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(!Array.isArray(result), 'no data → single message');
  assert.equal(result.type, 'tool_result');
});

test('mcp_tool_call with only images (no text) → still returns array', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'image-gen',
      tool: 'generate',
      status: 'completed',
      result: {
        content: [{ type: 'image', data: 'CCCC', mimeType: 'image/png' }],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(Array.isArray(result), 'image-only → still returns array');
  assert.equal(result[0].type, 'tool_result');
  // tool_result content should still show the tool info even without text
  assert.ok(result[0].content.includes('mcp:image-gen/generate'));
  assert.equal(result[1].type, 'system_info');
  const payload = JSON.parse(result[1].content);
  assert.equal(payload.block.items.length, 1);
});

// ── F060 P2: mimeType whitelist + base64 size guard ──

test('mcp_tool_call image with disallowed mimeType → gracefully skipped', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'evil',
      tool: 'upload',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', data: 'AAAA', mimeType: 'application/octet-stream' },
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(!Array.isArray(result), 'disallowed mimeType → single message');
  assert.equal(result.type, 'tool_result');
});

test('mcp_tool_call image exceeding 5MB base64 → gracefully skipped', () => {
  const hugeData = 'A'.repeat(5 * 1024 * 1024 + 1); // Just over 5MB
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'screenshots',
      tool: 'huge',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'big screenshot' },
          { type: 'image', data: hugeData, mimeType: 'image/png' },
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(!Array.isArray(result), 'oversized base64 → single message');
  assert.equal(result.type, 'tool_result');
});

test('mcp_tool_call image at exactly 5MB → accepted', () => {
  const data = 'A'.repeat(5 * 1024 * 1024); // Exactly 5MB
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'screenshots',
      tool: 'exact',
      status: 'completed',
      result: {
        content: [{ type: 'image', data, mimeType: 'image/png' }],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(Array.isArray(result), 'exactly 5MB → accepted');
  const payload = JSON.parse(result[1].content);
  assert.equal(payload.block.items.length, 1);
});

// ── Empty text suppression (empty bubble fix) ──

test('item.completed agent_message with empty text → null', () => {
  const msg = transformCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: '' } }, CAT);
  assert.equal(msg, null, 'empty text should be suppressed to avoid empty bubbles');
});

test('item.completed agent_message with whitespace-only text → null', () => {
  const msg = transformCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: '   \n\n  ' } }, CAT);
  assert.equal(msg, null, 'whitespace-only text should be suppressed');
});

test('item.completed agent_message with empty text after prior turn → null (not newlines)', () => {
  const state = { hadPriorTextTurn: true };
  const msg = transformCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: '' } }, CAT, state);
  assert.equal(msg, null, 'empty text after prior turn should not produce newline content');
});

test('mcp_tool_call mixed valid/invalid images → only valid included', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'mixed',
      tool: 'capture',
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: 'mixed' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'image', data: 'BBBB', mimeType: 'text/html' },
          { type: 'image', data: 'CCCC', mimeType: 'image/jpeg' },
        ],
      },
    },
  };
  const result = transformCodexEvent(event, CAT);
  assert.ok(Array.isArray(result), 'valid images present → array');
  const payload = JSON.parse(result[1].content);
  assert.equal(payload.block.items.length, 2, 'only image/png and image/jpeg');
  assert.ok(payload.block.items[0].url.startsWith('data:image/png;base64,'));
  assert.ok(payload.block.items[1].url.startsWith('data:image/jpeg;base64,'));
});
