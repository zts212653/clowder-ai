import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSharedPluginActionClient } from '../dist/routes/plugin-shared-mcp-client.js';

for (const entered of [false, true]) {
  test(`shared MCP failure preserves ${entered ? 'unknown' : 'not_started'} without replay`, async () => {
    let calls = 0;
    const client = createSharedPluginActionClient({
      signal: new AbortController().signal,
      record: {},
      token: 'fixture-token',
      fence: { identity: {}, close() {} },
      assertCurrent: async () => {
        if (!entered) throw new Error('private-revocation-details');
      },
      options: {
        sources: {},
        actions: {
          async call() {
            calls++;
            throw new Error('private-business-details');
          },
        },
      },
    });
    await assert.rejects(client.invoke('write', {}), (error) => {
      assert.equal(error.effect, entered ? 'unknown' : 'not_started');
      assert.doesNotMatch(error.message, /private-/);
      return true;
    });
    assert.equal(calls, entered ? 1 : 0);
  });
}
