import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerChatChanges } from '../src/routes/workspace-chat-changes.js';
import { comparison, metadata, targetKey } from './helpers/workspace-pull-request-changes-fixture.js';

test('explicit remote PR uses the existing diff reader only after owner/thread admission, with no local repository substitution', async () => {
  const app = Fastify(),
    calls: string[][] = [];
  registerChatChanges(
    app,
    (request) => (typeof request.headers['x-cat-cafe-user'] === 'string' ? request.headers['x-cat-cafe-user'] : null),
    {
      get: (id) => (id === 'thread-host' ? ({ createdBy: 'owner' } as never) : null),
    },
    {
      resolveRoot: async (id) => {
        assert.equal(id, 'registered-root');
        return '/controlled-registered-root';
      },
      execute: async (command, args) => {
        assert.equal(command, 'gh', 'No parent repository or local diff fallback');
        calls.push(args);
        return { stdout: JSON.stringify(args[1].includes('/pulls/') ? metadata() : comparison()) };
      },
    },
  );
  try {
    const url = `/api/workspace/chat-pull-request-changes?${new URLSearchParams({ target: targetKey })}`;
    for (const headers of [
      {},
      { 'x-cat-cafe-user': 'other' },
      { 'x-cat-cafe-user': 'owner', 'x-invocation-id': 'agent' },
    ]) {
      assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 403);
      assert.equal(calls.length, 0);
    }
    const response = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': 'owner' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.json().diff, /pull-request/);
    assert.equal(response.json().target.repoFullName, 'owner/repo');
    assert.equal(calls.length, 2);
  } finally {
    await app.close();
  }
});
