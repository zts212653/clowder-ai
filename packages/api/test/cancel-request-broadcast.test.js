import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCancelMessages } from '../dist/infrastructure/websocket/SocketManager.js';

test('a cancellation request broadcasts pending status for exact targets without a terminal', () => {
  const messages = buildCancelMessages({ cancelled: true, catIds: ['codex', 'opus'] });
  assert.deepEqual(
    messages.map((message) => message.catId),
    ['codex', 'opus'],
  );
  assert.equal(
    messages.every((message) => message.type === 'status'),
    true,
  );
  assert.equal(
    messages.some((message) => message.isFinal === true),
    false,
  );
  assert.equal(
    messages.every((message) => /停止|取消/.test(message.content)),
    true,
  );
});

test('unknown cancellation targets do not invent a default member or terminal', () => {
  assert.deepEqual(buildCancelMessages({ cancelled: true, catIds: [] }), []);
});

test('a rejected cancellation request broadcasts no status or completion', () => {
  assert.deepEqual(buildCancelMessages({ cancelled: false, catIds: ['codex'] }), []);
});
