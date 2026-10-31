import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.CAT_CAFE_API_URL;
const originalUserId = process.env.CAT_CAFE_USER_ID;
const originalCatId = process.env.CAT_CAFE_CAT_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
  else process.env.CAT_CAFE_API_URL = originalApiUrl;
  if (originalUserId === undefined) delete process.env.CAT_CAFE_USER_ID;
  else process.env.CAT_CAFE_USER_ID = originalUserId;
  if (originalCatId === undefined) delete process.env.CAT_CAFE_CAT_ID;
  else process.env.CAT_CAFE_CAT_ID = originalCatId;
});

test('companion MCP start is caller-bound and sends only named consumer plus explicit opt-in', async () => {
  process.env.CAT_CAFE_API_URL = 'http://api.test';
  process.env.CAT_CAFE_USER_ID = 'owner-1';
  process.env.CAT_CAFE_CAT_ID = 'codex-sol';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ status: 'active', consumer: 'watch_video', catId: 'codex-sol' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { handleRealtimeCompanionStart } = await import('../dist/tools/realtime-companion-tools.js');
  const result = await handleRealtimeCompanionStart({ thread_id: 'thread-1', consumer: 'watch_video' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://api.test/api/threads/thread-1/realtime-companion/start');
  assert.equal(calls[0].init.headers['x-cat-id'], 'codex-sol');
  assert.deepEqual(JSON.parse(calls[0].init.body), { consumer: 'watch_video', experimental: true });
});

test('companion MCP refuses to target a cat when the invocation identity is absent', async () => {
  delete process.env.CAT_CAFE_CAT_ID;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response('{}');
  };
  const { handleRealtimeCompanionStart } = await import('../dist/tools/realtime-companion-tools.js');
  const result = await handleRealtimeCompanionStart({ thread_id: 'thread-1', consumer: 'meeting_companion' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /current cat identity/i);
  assert.equal(fetchCalled, false);
});

test('companion MCP status and stop remain caller-bound and do not control F195 capture', async () => {
  process.env.CAT_CAFE_API_URL = 'http://api.test/';
  process.env.CAT_CAFE_USER_ID = 'owner-1';
  process.env.CAT_CAFE_CAT_ID = 'codex-sol';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ status: 'inactive', catId: 'codex-sol' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const { handleRealtimeCompanionStatus, handleRealtimeCompanionStop } = await import(
    '../dist/tools/realtime-companion-tools.js'
  );
  await handleRealtimeCompanionStatus({ thread_id: 'thread/one' });
  await handleRealtimeCompanionStop({ thread_id: 'thread/one' });
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method ?? 'GET', body: init.body })),
    [
      {
        url: 'http://api.test/api/threads/thread%2Fone/realtime-companion/status',
        method: 'GET',
        body: undefined,
      },
      {
        url: 'http://api.test/api/threads/thread%2Fone/realtime-companion/stop',
        method: 'POST',
        body: undefined,
      },
    ],
  );
  assert.equal(
    calls.some(({ url }) => url.includes('/api/audio/')),
    false,
  );
});
