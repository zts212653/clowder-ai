/**
 * F332 find unification: a failed or timed-out matters directory is never kept as the watcher's
 * "already read this wake" receipt. The same arguments reach the backend again after it recovers.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';

let saved;
let originalFetch;
beforeEach(() => {
  saved = { ...process.env };
  originalFetch = globalThis.fetch;
  for (const key of Object.keys(process.env)) if (key.startsWith('CAT_CAFE_')) delete process.env[key];
  process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:3102';
  process.env.CAT_CAFE_INVOCATION_ID = 'watcher-retry';
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'watcher-retry-fixture';
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  globalThis.fetch = originalFetch;
});

test('a failed directory read is retried after recovery instead of replayed as already read', async () => {
  const { handleSearchEvidence } = await import('@cat-cafe/mcp-server/dist/tools/evidence-tools.js');
  const { withMemoryReadPolicy } = await import('@cat-cafe/mcp-server/dist/tools/memory-read-access.js');
  const { watcherDirectoryReader } = await import(
    '../dist/domains/concierge/watcher/context/watcher-directory-read.js'
  );
  let backendCalls = 0;
  let failing = true;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    assert.equal(pathname, '/api/callbacks/memory-matters', 'the watcher reaches only its original route');
    backendCalls++;
    return failing
      ? Response.json({ error: 'temporary_directory_failure' }, { status: 503 })
      : Response.json({
          items: [
            {
              matterId: 'matter-1',
              title: 'Recovered',
              description: '',
              revision: 1,
              status: 'active',
              createdAt: 1,
              updatedAt: 2,
              entryCount: 1,
            },
          ],
        });
  };
  const run = {
    session: { id: 'session-watcher-retry', userId: 'owner', threadId: 'thread', catId: 'codex' },
    state: parseWatcherSessionState({
      revision: 0,
      afterSequence: 0,
      notes: '',
      attempt: {
        invocationId: 'watcher-retry',
        sourceInvocationId: 'source',
        sourceSequence: 1,
        startedAt: 1,
        phase: 'running',
      },
    }),
  };
  const owners = {
    sessions: { compareAndSetWatcherState: async (_id, _revision, next) => next },
    registry: {
      peekRecord: async () => ({
        userId: 'owner',
        threadId: 'thread',
        catId: 'codex',
        callbackToken: 'watcher-retry-fixture',
        toolExecutionPolicy: { mode: 'watcher', allowedToolNames: ['cat_cafe_search_evidence'] },
      }),
      verify: async () => ({ ok: true }),
      consumeWatcherToolCall: async () => 'accepted',
    },
  };
  const reader = watcherDirectoryReader(owners, run, {
    call: (_tool, args) => withMemoryReadPolicy({ watcher: true, readonly: false }, () => handleSearchEvidence(args)),
  });
  const directory = (result) => JSON.parse(result.content.find((block) => block.text?.startsWith('{"group"')).text);

  const first = await reader({}, 'first', new AbortController().signal);
  assert.equal(first.isError, true);
  assert.equal(directory(first).status, 'failed');
  assert.equal(run.state.directoryReads?.length ?? 0, 0, 'a failed directory leaves no reusable receipt');

  failing = false;
  const retried = await reader({}, 'retry-after-recovery', new AbortController().signal);
  assert.equal(backendCalls, 2);
  assert.equal(retried.isError, undefined);
  assert.equal(directory(retried).status, 'ok');
  assert.equal(directory(retried).items[0].matterId, 'matter-1');
  assert.equal(run.state.directoryReads?.length, 1, 'only the successful directory is kept for this wake');
});
