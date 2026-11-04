import assert from 'node:assert/strict';
import test from 'node:test';
import { ownedThreadFromSeed } from '../src/domains/cats/services/stores/ports/OwnedThreadSeed.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

function fixture() {
  const f = memberSessionFixture(),
    threads = new ThreadStore();
  let crash = false,
    current = true,
    creations = 0;
  let stopOnCreate = false;
  const scope = {
    ...f.scope(),
    assertCurrent: async () => {
      if (!current) throw new Error('installation_stopped');
    },
  };
  const service = () =>
    createPluginMemberSessions({
      ...f.deps,
      assertThread: async (owner: string, id: string, cat: string) => {
        assert.equal(threads.get(id)?.createdBy, owner);
        assert.equal(cat, 'member');
      },
      threadCreation: {
        workspace: async () => '/tmp/member-fixture',
        store: {
          ensureOwnedThread: async (seed: Parameters<ThreadStore['ensureOwnedThread']>[0]) => {
            const candidate = ownedThreadFromSeed(seed);
            const marker = await service().hostThreadBinding(candidate.id);
            assert.equal(marker?.catId, 'member', 'the deny-home marker must exist before the thread does');
            const thread = threads.ensureOwnedThread(seed);
            creations++;
            if (stopOnCreate) current = false;
            if (crash) {
              crash = false;
              throw new Error('simulated_exit_after_thread_creation');
            }
            return thread;
          },
        },
      },
    });
  const { threadId: _existing, ...prepared } = f.prepareInput;
  const input = { ...prepared, title: '本人的游戏会话' };
  return {
    ...f,
    threads,
    service,
    scope,
    input,
    create: () => service().hostCreateForInstance(scope),
    ensure: () => service().hostEnsureThreadForInstance(scope),
    crash: () => {
      crash = true;
    },
    stop: () => {
      current = false;
    },
    stopOnCreate: () => {
      stopOnCreate = true;
    },
    creations: () => creations,
  };
}

test('a source-linked owner creates a protected ordinary Host thread before preparing its member grant', async () => {
  const f = fixture();
  const session = await f.owner(() => f.create()(f.input));
  assert.equal(f.threads.get(session.threadId)?.createdBy, 'owner');
  assert.equal(session.catId, 'member');
  assert.equal((await f.service().hostThreadBinding(session.threadId))?.sessionId, session.sessionId);
  assert.equal(f.sends(), 0);
});

test('body approval cannot create a member thread, and a stopped activation cannot create one either', async () => {
  const f = fixture();
  await assert.rejects(() => f.create()({ ...f.input, ownerApproved: true }), /owner_authority/);
  assert.equal(f.creations(), 0);
  f.stop();
  await assert.rejects(() => f.owner(() => f.create()(f.input)), /installation_stopped/);
  assert.equal(f.creations(), 0);
});

test('an automatic owner list operation cannot create a controlled thread before confirmation', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.owner(() => f.create()(f.input), 'automatic-owner-list', false),
    /owner_confirmation_required/,
  );
  assert.equal(f.creations(), 0);
  assert.equal(f.rows.size, 0);
});

test('restarting after thread creation retains protection and retries the original owner request without duplicating the thread', async () => {
  const f = fixture();
  f.crash();
  await assert.rejects(() => f.owner(() => f.create()(f.input)), /simulated_exit/);
  const [thread] = f.threads.list('owner');
  assert.ok(thread);
  assert.ok(await f.service().hostThreadBinding(thread.id));
  const session = await f.owner(() => f.create()(f.input));
  assert.equal(session.threadId, thread.id);
  assert.equal(f.threads.list('owner').length, 1);
  assert.equal(session.generation, 1);
  assert.deepEqual(await f.owner(() => f.create()(f.input)), session);
  assert.equal(f.sends(), 0);
});

test('the same owner request cannot silently change its frozen member creation input', async () => {
  const f = fixture();
  await f.owner(() => f.create()(f.input));
  await assert.rejects(() => f.owner(() => f.create()({ ...f.input, title: 'changed' })), /creation_conflict/);
  assert.equal(f.threads.list('owner').length, 1);
  assert.equal(await f.service().hostThreadBinding('unrelated-thread'), null);
});

test('losing activation after creation leaves discoverable protection without a model grant', async () => {
  const f = fixture();
  f.stopOnCreate();
  await assert.rejects(() => f.owner(() => f.create()(f.input)), /installation_stopped/);
  const [thread] = f.threads.list('owner');
  assert.ok(thread);
  const marker = await f.service().hostThreadBinding(thread.id);
  assert.ok(marker);
  assert.equal(await f.service().forInstance(f.scope).get(marker.sessionId), null);
  assert.equal(f.sends(), 0);
});

test('an owner body cannot pick or adopt a different execution thread', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.owner(() => f.create()({ ...f.input, threadId: 'foreign-thread' })),
    /thread_id_is_host_owned/,
  );
  assert.equal(f.creations(), 0);
});

test('a stable owner preparation key retains one protected thread across separate HTTP requests without creating a grant', async () => {
  const f = fixture();
  const input = {
    catId: 'member',
    contributionId: 'player-tools',
    identity: 'game',
    title: '本人长期游戏线程',
    creationKey: 'world-member-seat',
  };
  const first = await f.owner(() => f.ensure()(input), 'http-request-1');
  const recovered = await f.owner(() => f.ensure()(input), 'http-request-2');
  assert.deepEqual(recovered, first);
  assert.equal(f.threads.list('owner').length, 1);
  assert.equal((await f.service().hostThreadBinding(first.threadId))?.sessionId, first.sessionId);
  assert.equal(await f.service().forInstance(f.scope).get(first.sessionId), null);
  assert.equal(f.sends(), 0);
  const session = await f.owner(
    () =>
      f
        .service()
        .forInstance(f.scope)
        .prepare({
          ...f.prepareInput,
          threadId: recovered.threadId,
        }),
    'http-confirm-resources',
  );
  assert.equal(session.threadId, first.threadId);
  assert.equal(session.generation, 1);
});

test('a lost thread acknowledgement is recoverable by a new owner request using the original stable preparation key', async () => {
  const f = fixture();
  const input = {
    catId: 'member',
    contributionId: 'player-tools',
    identity: 'game',
    title: '本人长期游戏线程',
    creationKey: 'world-member-seat',
  };
  f.crash();
  await assert.rejects(() => f.owner(() => f.ensure()(input), 'old-http-request'), /simulated_exit/);
  const [original] = f.threads.list('owner');
  const recovered = await f.owner(() => f.ensure()(input), 'new-http-request');
  assert.equal(recovered.threadId, original.id);
  assert.equal(f.threads.list('owner').length, 1);
  await assert.rejects(
    () => f.owner(() => f.ensure()({ ...input, title: 'changed frozen identity' }), 'another-request'),
    /creation_conflict/,
  );
  assert.equal(f.sends(), 0);
});

test('a stable preparation key never substitutes for current owner confirmation or permits caller-chosen thread ids', async () => {
  const f = fixture();
  const input = {
    catId: 'member',
    contributionId: 'player-tools',
    identity: 'game',
    title: '本人长期游戏线程',
    creationKey: 'world-member-seat',
  };
  await assert.rejects(() => f.owner(() => f.ensure()(input), 'automatic', false), /owner_confirmation_required/);
  await assert.rejects(() => f.ensure()(input), /owner_authority/);
  await assert.rejects(
    () => f.owner(() => f.ensure()({ ...input, threadId: 'foreign' })),
    /thread_id_is_host_owned|invalid_member/,
  );
  assert.equal(f.threads.list('owner').length, 0);
});

for (const kind of ['legacy-create', 'ensure-thread'])
  test(`${kind} captures the confirmed thread input before its first authority await`, async () => {
    const f = fixture();
    const { memory: _memory, ...identity } = f.input;
    const input = kind === 'legacy-create' ? { ...f.input } : { ...identity, creationKey: 'stable-seat' };
    const originalTitle = input.title;
    const operation = f.owner(() => (kind === 'legacy-create' ? f.create()(input) : f.ensure()(input)));
    input.title = 'changed-after-the-confirmed-call';
    await operation;
    assert.equal(f.threads.list('owner')[0]?.title, originalTitle);
  });
