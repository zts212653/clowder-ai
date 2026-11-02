import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberSessionHost } from '../src/domains/plugin/member-sessions/host.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { MemberSessionStore } from '../src/domains/plugin/member-sessions/store.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture() {
  const f = memberSessionFixture();
  const sessions = createPluginMemberSessions(f.deps),
    host = createMemberSessionHost(sessions);
  const direct = sessions.forInstance(f.scope());
  const session = await f.owner(() => direct.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'event',
    semanticCursor: 1,
    content: 'local event',
  };
  const store = new MemberSessionStore(f.deps.storage);
  return { ...f, sessions, host, session, input, store };
}

test('a stopped original admission cannot be adopted by a fresh activation', async () => {
  const f = await fixture();
  let active = true;
  const stop = new AbortController();
  const originalScope = {
    ...f.scope(),
    assertCurrent: async () => {
      if (!active) throw new Error('original_activation_stopped');
    },
  };
  const port = f.host.forInstance(originalScope, stop.signal);
  const queued = await port.execute(f.input);
  active = false;
  stop.abort('installation_stopped');
  await assert.rejects(f.host.forInstance(f.scope()).execute(f.input), /original_activation_stopped/);
  const row = (await f.store.get(f.session.sessionId))!.value;
  assert.equal(f.host.executionSignal(row, queued).aborted, true);
  await assert.rejects(f.host.executionScope(row, queued).assertCurrent(), /original_activation_stopped/);
  assert.equal(f.sends(), 1);
});

test('revoke aborts only this session and generation while preserving persistent input', async () => {
  const f = await fixture(),
    port = f.host.forInstance(f.scope());
  const queued = await port.execute(f.input);
  const row = (await f.store.get(f.session.sessionId))!.value;
  assert.equal(f.host.executionSignal(row, queued).aborted, false);
  await f.owner(() => port.revoke(f.session.sessionId));
  assert.equal(f.host.executionSignal(row, queued).reason, 'user_cancel');
  const saved = (await f.store.get(f.session.sessionId))!.value;
  assert.equal(saved.executions.event.messageId, queued.messageId);
  assert.equal(saved.consumedCursor, 0);
  await assert.rejects(port.execute({ ...f.input, executionId: 'replacement' }), /revoked/);
});

test('Host recreation preserves queued facts without manufacturing an old child permission', async () => {
  const f = await fixture(),
    port = f.host.forInstance(f.scope());
  const queued = await port.execute(f.input);
  const row = (await f.store.get(f.session.sessionId))!.value;
  const recreated = createMemberSessionHost(f.sessions);
  assert.throws(() => recreated.executionScope(row, queued), /original_admission_scope_unavailable/);
  await assert.rejects(
    recreated.assertCallback({
      userId: 'owner',
      threadId: 'game-thread',
      catId: 'member',
      invocationId: 'old-child',
      originTriggerMessageId: queued.messageId,
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'installed',
        contributionId: 'player-tools',
        memberSession: { sessionId: row.sessionId, generation: row.generation, executionId: 'event' },
      },
    }),
    /original_callback_scope_unavailable/,
  );
  assert.equal((await port.get(row.sessionId))?.generation, row.generation);
  assert.equal(f.sends(), 1);
});

test('the module cannot prepare an ordinary home thread without its Host-owned marker', async () => {
  const f = await fixture();
  await assert.rejects(
    f.owner(() => f.host.forInstance(f.scope()).prepare(f.prepareInput)),
    /thread_is_not_controlled/,
  );
});

test('a fresh Host activation cannot revive a persisted grant; a new owner request can renew it', async () => {
  const f = memberSessionFixture();
  const oldScope = { ...f.scope(), activationId: 'original-activation' };
  const sessions = createPluginMemberSessions(f.deps);
  const first = await f.owner(() => sessions.forInstance(oldScope).prepare(f.prepareInput));
  const input = {
    sessionId: first.sessionId,
    generation: first.generation,
    executionId: 'event',
    semanticCursor: 1,
    content: 'original local event',
  };
  await createMemberSessionHost(sessions).forInstance(oldScope).execute(input);
  const newScope = { ...f.scope(), activationId: 'new-activation' };
  const restarted = createMemberSessionHost(createPluginMemberSessions(f.deps)).forInstance(newScope);
  await assert.rejects(restarted.execute(input), /activation_changed/);
  await assert.rejects(
    f.owner(() => sessions.forInstance(newScope).prepare(f.prepareInput)),
    /activation_changed/,
  );
  const renewed = await f.owner(
    () => sessions.forInstance(newScope).prepare(f.prepareInput),
    'new-owner-resource-confirmation',
  );
  assert.equal(renewed.sessionId, first.sessionId);
  assert.equal(renewed.generation, first.generation + 1);
  await assert.rejects(restarted.execute(input), /generation_changed/);
  assert.equal(f.sends(), 1);
});
