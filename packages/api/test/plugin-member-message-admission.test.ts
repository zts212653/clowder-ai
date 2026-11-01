import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createMessagingDomain } from '../src/domains/messaging/messaging-service.js';
import { createMessagingStores } from '../src/domains/messaging/stores/factory.js';
import {
  createPluginMessagingHost,
  type PluginMessagingHostDeps,
} from '../src/domains/plugin/host-surface/plugin-messaging-host.js';
import { createMemberSessionMessaging } from '../src/domains/plugin/member-sessions/messaging.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture() {
  const messages = new MessageStore(),
    threads = new ThreadStore(),
    stores = createMessagingStores();
  const thread = await threads.create('owner', 'Member game');
  let current = true,
    wakes = 0,
    checks = 0;
  const messaging = createMessagingDomain({
    messageStore: messages,
    stores,
    isKnownCatId: (id) => id === 'codex',
    invokeTrigger: {
      trigger: async () => {
        wakes++;
        return 'enqueued';
      },
    },
  });
  const hostDeps: PluginMessagingHostDeps = {
    pluginId: 'test.member',
    pluginInstanceId: 'installed',
    ownerUserId: 'owner',
    threadStore: threads,
    messageStore: messages,
    messaging,
    manifest: {
      pluginId: 'test.member',
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Member',
      runtime: { transport: 'builtin', entrypoint: 'index.mjs' },
      features: [
        {
          id: 'game',
          name: 'Game',
          resources: [],
          capabilities: ['messaging.send'],
          contributions: [{ type: 'identity', id: 'game' }],
        },
      ],
      contributions: [{ type: 'identity', id: 'game', displayName: 'Game' }],
    },
    assertAdmissionCurrent: async () => {
      checks++;
      if (!current) throw new Error('member_session_generation_changed');
    },
  };
  const host = createPluginMessagingHost(hostDeps);
  const input = {
    threadId: thread.id,
    identity: 'game',
    idempotencyKey: 'original-event',
    wake: { catId: 'codex', exact: true as const },
    payload: {
      provenance: { epistemicStatus: 'observation' as const },
      elements: [{ elementId: 'event', kind: 'text' as const, payload: { text: 'own local change' } }],
    },
  };
  return {
    host,
    hostDeps,
    messages,
    stores,
    thread,
    input,
    revoke: () => {
      current = false;
    },
    wakes: () => wakes,
    checks: () => checks,
  };
}

test('member authority is rechecked after the real address lookup and before message persistence', async () => {
  const f = await fixture();
  const get = f.stores.handles.get.bind(f.stores.handles);
  f.stores.handles.get = async (...args) => {
    const result = await get(...args);
    f.revoke();
    return result;
  };
  await assert.rejects(() => f.host.send(f.input), /generation_changed/);
  assert.equal(f.messages.getByThread(f.thread.id).length, 0);
  assert.equal(f.wakes(), 0);
});

test('revocation during the real publish await prevents the later model wake', async () => {
  const f = await fixture();
  const append = f.stores.events.append.bind(f.stores.events);
  f.stores.events.append = async (...args) => {
    const result = await append(...args);
    f.revoke();
    return result;
  };
  await assert.rejects(() => f.host.send(f.input), /generation_changed/);
  assert.equal(f.messages.getByThread(f.thread.id).length, 1, 'the already accepted original remains recoverable');
  assert.equal(f.wakes(), 0);
});

test('a settled original receipt remains a read-only replay with no new message or wake', async () => {
  const f = await fixture();
  const original = await f.host.send(f.input);
  assert.ok(f.checks() > 0);
  f.revoke();
  assert.deepEqual(await f.host.send(f.input), original);
  assert.equal(f.messages.getByThread(f.thread.id).length, 1);
  assert.equal(f.wakes(), 1);
});

test('the member transport binds the execution scope to real Host send preparation', async () => {
  const f = await fixture();
  const transport = createMemberSessionMessaging(async () => f.hostDeps);
  const guard = f.hostDeps.assertAdmissionCurrent;
  assert.ok(guard);
  const get = f.stores.handles.get.bind(f.stores.handles);
  f.stores.handles.get = async (...args) => {
    const result = await get(...args);
    f.revoke();
    return result;
  };
  await assert.rejects(
    () =>
      transport.send(
        {
          threadId: f.thread.id,
          identity: 'game',
          idempotencyKey: 'member-event',
          content: 'local input',
          wake: { catId: 'codex', exact: true },
        },
        { pluginInstanceId: 'installed', packageDigest: 'package', ownerUserId: 'owner', assertCurrent: guard },
      ),
    /generation_changed/,
  );
  assert.equal(f.messages.getByThread(f.thread.id).length, 0);
  assert.equal(f.wakes(), 0);
});

test('an immediate execution fence cannot be carried into deferred media publication', async () => {
  const f = await fixture();
  await assert.rejects(
    () =>
      f.host.send({
        ...f.input,
        sourceEventId: 'deferred',
        payload: {
          provenance: { epistemicStatus: 'observation' },
          elements: [
            {
              elementId: 'media',
              kind: 'media_ref',
              payload: { reference: 'pmr_example', sourceId: 'source', type: 'image' },
            },
          ],
        },
      }),
    /durable admission authority/,
  );
  assert.equal(f.messages.getByThread(f.thread.id).length, 0);
  assert.equal(f.wakes(), 0);
});

test('unrepresentable member input is rejected before acquiring an immutable pending lease', async () => {
  const f = memberSessionFixture(),
    port = f.bind();
  const session = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'invalid-input',
    semanticCursor: 1,
    content: '"'.repeat(40000),
  };
  await assert.rejects(() => port.execute(input), /contract validation/);
  assert.equal(f.attempts(), 0);
  const accepted = await port.execute({ ...input, executionId: 'valid-input', content: 'own local event' });
  assert.ok(accepted.messageId);
  assert.equal(f.sends(), 1);
});
