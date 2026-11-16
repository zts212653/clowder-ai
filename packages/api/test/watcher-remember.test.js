import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, items, paths } from './helpers/watcher-remember-fixture.js';

test('four original submissions share one claimed remember ticket and only the batch receipt is archived', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.admit('one'), 'accepted');
  const result = await f.app.inject(f.request('one'));
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    result.json().results.map((row) => row.statusCode),
    [200, 200, 200, 200],
  );
  assert.deepEqual(
    f.calls.map((row) => row.target),
    ['profile', 'taste', 'matter', 'profile'],
  );
  assert.ok(
    f.calls.every(
      (row) => row.invocationId === f.auth.invocationId && row.userId === 'owner' && row.source === 'source',
    ),
  );
  assert.equal(f.claims.length, 1, 'children cannot claim the parent ticket');
  assert.equal(f.receipts.length, 1, 'a child receipt cannot replace the full batch receipt');
  assert.equal(await f.registry.watcherToolCallCount(f.auth.invocationId), 1);
  const replay = await f.app.inject(f.request('one'));
  assert.deepEqual(replay.json(), result.json());
  assert.equal(f.calls.length, 4);
  const changed = f.request('one');
  changed.payload.clientRequestId = 'different';
  assert.equal((await f.app.inject(changed)).statusCode, 403);
  assert.equal(f.calls.length, 4);
});

test('remember preserves the original callback allowlist and its ticket cannot directly invoke a domain writer', async (t) => {
  const f = await fixture(t, { allowed: ['profile'] });
  await f.admit('limited');
  const result = await f.app.inject(
    f.request('limited', {
      clientRequestId: 'limited',
      items: [items[0], items[1], { itemId: 'person', target: 'person', payload: {} }],
    }),
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(
    result.json().results.map((row) => row.statusCode),
    [200, 403, 403],
  );
  assert.equal(f.calls.length, 1);
  const direct = {
    method: 'POST',
    url: paths.profile,
    headers: { ...f.headers, 'x-watcher-tool-call-id': 'limited', 'x-watcher-remember-forward': 'true' },
    payload: items[0].payload,
  };
  assert.equal((await f.app.inject(direct)).statusCode, 403);
  await f.admit('read', 'cat_cafe_get_message');
  assert.equal((await f.app.inject(f.request('read'))).statusCode, 403);
  assert.equal((await f.app.inject(f.request('unadmitted'))).statusCode, 403);
  assert.equal(f.calls.length, 1);
});

test('an in-flight batch cannot be replayed or lend its internal authorization to a concurrent HTTP request', async (t) => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  t.after(() => release());
  const f = await fixture(t, {
    onChild: async () => {
      entered();
      await gate;
    },
  });
  await f.admit('concurrent');
  const first = f.app.inject(f.request('concurrent'));
  await Promise.race([started, first.then((response) => assert.equal(f.calls.length, 1, response.body))]);
  try {
    const pending = await f.app.inject(f.request('concurrent'));
    assert.equal(pending.statusCode, 409, pending.body);
    const forged = await f.app.inject({
      method: 'POST',
      url: paths.profile,
      headers: { ...f.headers, 'x-watcher-tool-call-id': 'concurrent' },
      payload: items[0].payload,
    });
    assert.equal(forged.statusCode, 403);
    assert.equal(f.calls.length, 1);
  } finally {
    release();
  }
  assert.equal((await first).statusCode, 200);
  assert.equal(f.calls.length, 4);
});

test('a missing durable receipt after partial side effects is result-unknown, never permission to dispatch again', async (t) => {
  const f = await fixture(t, {
    onChild: async (target) => {
      if (target === 'taste') throw new Error('original domain failed');
    },
  });
  await f.admit('unknown');
  f.registry.completeWatcherToolCallback = async () => {};
  const first = await f.app.inject(f.request('unknown'));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(
    first.json().results.map((row) => row.statusCode),
    [200, 500, 200, 200],
  );
  assert.equal(f.calls.length, 4);
  const replay = await f.app.inject(f.request('unknown'));
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal(replay.json().error, 'watcher_tool_result_pending');
  assert.equal(f.calls.length, 4);
});

test('invalid batch size is refused before forwarding and six remember tickets remain the complete tool budget', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    assert.equal(await f.admit(`bad-${i}`), 'accepted');
    const bad = await f.app.inject(
      f.request(`bad-${i}`, { clientRequestId: 'five', items: [...items, { ...items[0], itemId: 'fifth' }] }),
    );
    assert.equal(bad.statusCode, 400, bad.body);
  }
  assert.equal(await f.admit('seventh'), 'exhausted');
  assert.equal(f.calls.length, 0);
  assert.equal(await f.registry.watcherToolCallCount(f.auth.invocationId), 6);
});
