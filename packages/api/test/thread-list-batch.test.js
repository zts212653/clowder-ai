import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';

function fixture(count = 8, onExec) {
  const ids = Array.from({ length: count }, (_, i) => `thread_${i}`);
  ids.push('default');
  const hashes = new Map(
    ids.map((id, i) => [
      `thread:${id}`,
      {
        id,
        createdBy: id === 'default' ? 'system' : 'alice',
        projectPath: i % 2 ? '/project/b' : '/project/a',
        title: id,
        lastActiveAt: String(i),
        createdAt: '1',
      },
    ]),
  );
  const batches = [];
  const reads = { direct: 0, index: 0 };
  const members = ['opus', 'codex-astra'];
  const redis = {
    options: { keyPrefix: '' },
    zrevrange: async (key) => {
      assert.equal(key, 'threads:user:alice');
      reads.index += 1;
      return [...ids];
    },
    hgetall: async (key) => {
      reads.direct += 1;
      return hashes.get(key) ?? {};
    },
    smembers: async () => {
      reads.direct += 1;
      return [...members];
    },
    multi() {
      const commands = [];
      const batch = {
        hgetall(key) {
          commands.push(['hash', key]);
          return batch;
        },
        smembers(key) {
          commands.push(['members', key]);
          return batch;
        },
        async exec() {
          batches.push(commands);
          const replies = commands.map(([kind, key]) => [
            null,
            kind === 'hash' ? (hashes.get(key) ?? {}) : [...members],
          ]);
          return onExec ? onExec(replies, batches.length) : replies;
        },
      };
      return batch;
    },
  };
  return { store: new RedisThreadStore(redis), ids, hashes, batches, reads, members };
}

test('2,048-thread navigation stays within a bounded Redis round-trip budget', async (t) => {
  const { store, ids, batches, reads } = fixture(2048);
  const threads = await store.list('alice');

  assert.equal(threads.length, ids.length);
  assert.equal(new Set(threads.map((thread) => thread.id)).size, ids.length);
  assert.equal(reads.index, 1);
  assert.ok(reads.direct + batches.length <= 32, `navigation required ${reads.direct + batches.length} backing reads`);
  assert.ok(
    batches.every((batch) => batch.length <= 256),
    'one read batch must not monopolize Redis with the full list',
  );
  t.diagnostic(
    `${threads.length} rows: ${reads.index} index read, ${batches.length} batches, ${reads.direct} direct reads`,
  );
});

test('batched list preserves canonical hydration, participant sets, filtering and project selection', async () => {
  const { store, ids, hashes, members } = fixture(260);
  hashes.get('thread:thread_0').deletedAt = '100';
  hashes.get('thread:thread_1').externalRuntimeAnchorState = JSON.stringify({
    v: 1,
    runtime: 'antigravity-desktop',
    userId: 'alice',
    createdAt: 1,
  });
  hashes.get('thread:thread_2').pinned = 'true';
  hashes.get('thread:thread_2').pinnedAt = '9';
  hashes.get('thread:thread_2').archivedAt = '10';
  hashes.get('thread:thread_3').lastActiveAt = '2';
  // Private metadata stays outside the public Thread DTO.
  hashes.get('thread:thread_2').threadMetadata = JSON.stringify({
    v: 1,
    attentionGroup: { v: 1, groupId: 'attention_x', order: 0 },
  });

  const expected = [];
  for (const id of ids) {
    const thread = await store.get(id);
    if (thread && !thread.deletedAt && !thread.externalRuntimeAnchorState) expected.push(thread);
  }
  expected.sort((left, right) => right.lastActiveAt - left.lastActiveAt);

  assert.deepEqual(await store.list('alice'), expected);
  assert.deepEqual(
    await store.listByProject('alice', '/project/a'),
    expected.filter((t) => t.projectPath === '/project/a'),
  );
  assert.deepEqual(expected.find((t) => t.id === 'thread_2').participants, members);
  assert.equal(expected.find((t) => t.id === 'thread_2').metadata, undefined);
});

test('missing detail hashes retain the existing get/recovery path, including the default thread', async () => {
  const { store, hashes } = fixture();
  hashes.delete('thread:thread_1');
  hashes.set('thread:thread_2', { title: 'orphan hash without canonical id' });
  hashes.delete('thread:default');
  const ordinaryGet = store.get.bind(store);
  const recovered = [];
  store.get = async (id, options) => {
    if (!['thread_1', 'thread_2', 'default'].includes(id)) return ordinaryGet(id, options);
    recovered.push(id);
    return id === 'thread_2' ? null : { id, createdAt: 1, lastActiveAt: 100, participants: [] };
  };

  const threads = await store.list('alice');
  assert.deepEqual(recovered, ['thread_1', 'thread_2', 'default']);
  assert.ok(threads.some((t) => t.id === 'thread_1'));
  assert.ok(threads.some((t) => t.id === 'default'));
  assert.ok(!threads.some((t) => t.id === 'thread_2'));
});

for (const [label, corrupt] of [
  ['null batch', () => null],
  ['short batch', (rows) => rows.slice(0, -1)],
  ['hash error', (rows) => [[new Error('hash unavailable'), null], ...rows.slice(1)]],
  ['null hash', (rows) => [[null, null], ...rows.slice(1)]],
  ['array hash', (rows) => [[null, []], ...rows.slice(1)]],
  ['members error', (rows) => [rows[0], [new Error('members unavailable'), null], ...rows.slice(2)]],
  ['null members', (rows) => [rows[0], [null, null], ...rows.slice(2)]],
]) {
  test(`list rejects ${label} instead of presenting an empty or partial navigation snapshot`, async () => {
    const { store } = fixture(8, corrupt);
    await assert.rejects(store.list('alice'));
  });
}

for (const detail of ['missing', 'missing-id']) {
  for (const [label, reply] of [
    ['error', [new Error('members unavailable'), null]],
    ['null', [null, null]],
    ['non-array', [null, 'not a set']],
    ['short reply', undefined],
  ]) {
    test(`${detail} detail rejects paired members ${label} before recovery`, async () => {
      const { store, hashes, ids } = fixture(8, (rows) => [...rows.slice(0, -1), reply]);
      // Put the missing detail last, so a short paired reply cannot be caught
      // accidentally by validating an unrelated later hash.
      ids.push(ids.shift());
      hashes.set('thread:thread_0', detail === 'missing' ? {} : { title: 'orphan' });
      let recoveryCalls = 0;
      store.get = async () => {
        recoveryCalls += 1;
        return null;
      };

      await assert.rejects(store.list('alice'));
      assert.equal(recoveryCalls, 0, 'invalid queued replies must not enter default creation or recovery');
    });
  }
}

test('a later batch error prevents recovery for an earlier missing detail', async () => {
  const { store, hashes } = fixture(8, (rows) => [
    ...rows.slice(0, -1),
    [new Error('later members unavailable'), null],
  ]);
  hashes.delete('thread:thread_0');
  let recoveryCalls = 0;
  store.get = async () => {
    recoveryCalls += 1;
    return null;
  };

  await assert.rejects(store.list('alice'), /later members unavailable/);
  assert.equal(recoveryCalls, 0, 'the whole batch must validate before recovery has side effects');
});

test('abort releases an in-flight batch promptly and does not start another batch', async () => {
  let batchStarted;
  const started = new Promise((resolve) => {
    batchStarted = resolve;
  });
  let releaseBatch;
  const { store, batches } = fixture(260, (rows) => {
    batchStarted();
    return new Promise((resolve) => {
      releaseBatch = () => resolve(rows);
    });
  });
  const controller = new AbortController();
  const pending = store.list('alice', { signal: controller.signal });
  await started;
  const rejected = assert.rejects(pending, /navigation cancelled/);
  controller.abort(new Error('navigation cancelled'));
  await rejected;
  releaseBatch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batches.length, 1);
});

test('abort at a completed batch boundary prevents further hydration or Redis work', async () => {
  const controller = new AbortController();
  const { store, batches } = fixture(260, (rows) => {
    controller.abort(new Error('scan deadline'));
    return rows;
  });
  await assert.rejects(store.list('alice', { signal: controller.signal }), /scan deadline/);
  assert.equal(batches.length, 1);
});
