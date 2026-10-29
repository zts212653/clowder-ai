import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCodexAppServerThread } from '../dist/domains/cats/services/agents/providers/CodexAppServerThreadResolver.js';
import {
  inspectCodexInput,
  readCodexActiveWriterMetadata,
  readCodexTurnMetadata,
} from '../dist/domains/cats/services/agents/providers/codex-history-reader.js';

test('continuity verdict retains required metadata without retaining provider history', async () => {
  const raw = {
    thread: { id: 'native', turns: [{ id: 'old', items: [{ text: 'private history' }] }] },
    model: 'model',
    reasoningEffort: 'high',
  };
  const result = await resolveCodexAppServerThread({
    thread: { kind: 'resume', threadId: 'native' },
    params: {},
    localLiveLease: false,
    request: async () => raw,
    now: () => 1,
  });
  assert.equal(result.kind, 'resumed');
  assert.equal(result.threadId, 'native');
  assert.equal(result.raw.model, 'model');
  assert.equal(result.raw.reasoningEffort, 'high');
  assert.equal(result.raw.thread.turns, undefined, 'continuity must not transport or retain full history');
  assert.notEqual(result.raw, raw);
});

test('input receipt pages only the requested turn and never accepts another turn user message', async () => {
  const calls = [];
  const result = await inspectCodexInput(
    async (method, params) => {
      calls.push({ method, params });
      return params.cursor
        ? { data: [{ turnId: 'current', item: { type: 'userMessage', clientId: 'delivery' } }], nextCursor: null }
        : { data: [{ turnId: 'old', item: { type: 'userMessage', clientId: 'delivery' } }], nextCursor: 'older' };
    },
    'native',
    'current',
    'delivery',
  );
  assert.equal(result, 'accepted');
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      ({ method, params }) =>
        method === 'thread/items/list' &&
        params.turnId === 'current' &&
        params.threadId === 'native' &&
        params.limit === 50,
    ),
  );
});

test('metadata paging rejects repeated cursors without falling back to complete history', async () => {
  const calls = [];
  await assert.rejects(async () => {
    for await (const _turn of readCodexTurnMetadata(async (method, params) => {
      calls.push({ method, params });
      return { data: [{ id: 'old', status: 'completed' }], nextCursor: 'same' };
    }, 'native')) {
      /* consume */
    }
  }, /cursor did not advance/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ params }) => params.itemsView === 'notLoaded'));
});

test('active-writer evidence combines metadata with an active turn coordinate, not history items', async () => {
  const calls = [];
  const result = await readCodexActiveWriterMetadata(async (method, params) => {
    calls.push({ method, params });
    return method === 'thread/read'
      ? { thread: { id: 'native', status: { type: 'active' } } }
      : {
          data: [{ id: 'active', status: 'inProgress', startedAt: 123, items: [{ text: 'private' }] }],
          nextCursor: 'older',
        };
  }, 'native');
  assert.deepEqual(result, {
    thread: {
      id: 'native',
      status: { type: 'active' },
      turns: [{ id: 'active', status: 'inProgress', startedAt: 123 }],
    },
  });
  assert.equal(calls[0].params.includeTurns, false);
  assert.equal(calls[1].params.itemsView, 'notLoaded');
  assert.equal(calls.length, 2, 'an active coordinate does not require reading the remaining past');
});
