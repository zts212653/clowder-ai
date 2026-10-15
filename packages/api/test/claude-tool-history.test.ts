import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { transformClaudeEvent } from '../src/domains/cats/services/agents/providers/claude-ndjson-parser.js';
import { toStoredToolEvent } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { TranscriptWriter } from '../src/domains/cats/services/session/TranscriptWriter.js';

test('Claude child results retain native parent scope and status in stored history', () => {
  const state = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  transformClaudeEvent(
    {
      type: 'assistant',
      parent_tool_use_id: 'parent',
      message: { content: [{ type: 'tool_use', id: 'child', name: 'Read', input: { file_path: 'child.txt' } }] },
    },
    createCatId('opus'),
    state,
  );
  const parsed = transformClaudeEvent(
    {
      type: 'user',
      parent_tool_use_id: 'parent',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child', content: 'native failure', is_error: true }] },
    },
    createCatId('opus'),
    state,
  );
  assert.ok(Array.isArray(parsed));
  const stored = toStoredToolEvent(parsed[0]);
  assert.ok(stored);
  assert.equal(stored.toolName, 'Read');
  assert.equal((stored as unknown as Record<string, unknown>).toolParentUseId, 'parent');
  assert.equal(stored.toolUseId, 'child');
  assert.equal(stored.status, 'error');
  assert.equal(stored.detail, 'native failure');
});

test('canonical transcript retains full raw results while history preview stays bounded', async () => {
  const parent = resolve('.cat-cafe/tmp/w1-persistence-tests');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'transcript-'));
  const writer = new TranscriptWriter({ dataDir: dir });
  const session = { sessionId: 'session', threadId: 'thread', catId: 'opus', cliSessionId: 'native', seq: 0 };
  const state = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set<string>(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  const output = `native sentinel ${'x'.repeat(3000)} end sentinel`;
  transformClaudeEvent(
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'long', name: 'Read', input: { file_path: 'long.txt' } }] },
    },
    createCatId('opus'),
    state,
  );
  const parsed = transformClaudeEvent(
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'long', content: output }] } },
    createCatId('opus'),
    state,
  );
  assert.ok(Array.isArray(parsed));
  writer.appendEvent(session, parsed[0] as unknown as Record<string, unknown>, 'invocation');
  await writer.drainPendingWrites();
  await writer.flush(session);
  const native = await readFile(join(dir, 'threads/thread/opus/sessions/session/events.jsonl'), 'utf8');
  const event = JSON.parse(native.trim()).event;
  assert.equal(event.content, output);
  assert.equal(event.toolRawPayload.rawOutput, output);
  const stored = toStoredToolEvent(parsed[0]);
  assert.ok(stored);
  assert.ok((stored.detail?.length ?? 0) < output.length);
  assert.equal(stored.status, 'ok');
});
