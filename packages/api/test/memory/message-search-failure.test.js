import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

for (const [error, expectedReason] of [
  [new DOMException('deadline exceeded', 'TimeoutError'), 'message_search_timeout'],
  [new Error('database read failed'), 'message_search_error'],
]) {
  test(`message search exposes ${expectedReason} distinctly from unavailable service and zero hits`, async () => {
    let status;
    const reply = {
      raw: new EventEmitter(),
      log: { warn() {} },
      status: (code) => {
        status = code;
      },
    };
    const response = await executeMessageSearch(
      {
        search: async () => {
          throw error;
        },
      },
      { query: 'piano' },
      { userId: 'owner', viewer: { type: 'user' } },
      reply,
    );
    assert.equal(status, 503);
    assert.equal(response.degraded, true);
    assert.equal(response.degradeReason, expectedReason);
    assert.equal(reply.raw.listenerCount('close'), 0);
    const missing = await executeMessageSearch(
      undefined,
      { query: 'piano' },
      { userId: 'owner', viewer: { type: 'user' } },
      reply,
    );
    assert.equal(missing.degradeReason, 'message_search_unavailable');
  });
}
