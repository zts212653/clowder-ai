import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  createCompanionDecisionNavigation,
  createCompanionDecisionSocketDelivery,
} from '../src/domains/concierge/live/host/unified/companion-decision-navigation.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';

function fixture() {
  const messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'project');
  const message = messages.append({
    threadId: thread.id,
    userId: 'owner',
    catId: null,
    content: 'source',
    timestamp: 1,
    mentions: [],
    extra: { rich: { v: 1, blocks: [{ kind: 'card', v: 1, id: 'card', title: 'source' }] } },
  });
  let recipient = true,
    current = true;
  const emitted: object[] = [];
  const ports = createCompanionDecisionNavigation({
    ownerUserId: 'owner',
    messages,
    threads,
    assertCurrent: async () => {
      if (!current) throw new Error('stale lease');
    },
    hasRecipient: () => recipient,
    emit: (destination) => {
      emitted.push(destination);
    },
  });
  const destination = { threadId: thread.id, messageId: message.id, blockId: 'card' };
  return {
    ports,
    destination,
    emitted,
    message,
    thread,
    disconnect: () => {
      recipient = false;
    },
    revoke: () => {
      current = false;
    },
  };
}

test('navigation delivers only a persisted owner source and its real block through the owner port', async () => {
  const f = fixture();
  assert.equal(await f.ports.canOpenDecision(f.destination), true);
  assert.equal(await f.ports.openDecision(f.destination), true);
  assert.deepEqual(f.emitted, [f.destination]);
});

test('foreign messages, foreign threads, missing blocks and deleted or recalled sources cannot navigate', async () => {
  const f = fixture();
  assert.equal(await f.ports.openDecision({ ...f.destination, blockId: 'missing' }), false);
  f.message.userId = 'foreign';
  assert.equal(await f.ports.openDecision(f.destination), false);
  f.message.userId = 'owner';
  f.thread.createdBy = 'foreign';
  assert.equal(await f.ports.openDecision(f.destination), false);
  f.thread.createdBy = 'owner';
  f.message.deletedAt = 1;
  assert.equal(await f.ports.openDecision(f.destination), false);
  f.message.deletedAt = undefined;
  f.message.deliveryStatus = 'canceled';
  assert.equal(await f.ports.openDecision(f.destination), false);
  assert.deepEqual(f.emitted, []);
});

test('no connected owner recipient means unconfirmed; a stale lease rejects before emitting', async () => {
  const f = fixture();
  f.disconnect();
  assert.equal(await f.ports.openDecision(f.destination), false);
  f.revoke();
  await assert.rejects(f.ports.openDecision(f.destination), /stale lease/);
  assert.deepEqual(f.emitted, []);
});

test('only the original session owner receives source coordinates even when legacy sockets share a room', async (t) => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const cookies: string[] = [];
  for (const ownerUserId of ['configured-owner', 'other-owner']) {
    const app = Fastify();
    apps.push(app);
    t.after(() => app.close());
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    const response = await app.inject('/api/session');
    const header = response.headers['set-cookie'];
    assert.ok(typeof header === 'string');
    cookies.push(header.split(';')[0]!);
  }
  const received: number[] = [];
  const sockets = [cookies[0], cookies[1], undefined, 'cat_cafe_session=forged'].map((header, index) => ({
    handshake: { headers: { cookie: header } },
    emit: () => {
      received.push(index);
    },
  }));
  const delivery = createCompanionDecisionSocketDelivery({
    ownerUserId: 'configured-owner',
    parseCookie: (header) => apps[0]!.parseCookie(header),
    sockets: () => sockets,
  });
  assert.equal(delivery.hasRecipient(), true);
  delivery.emit({ threadId: 'private-thread', messageId: 'private-message' });
  assert.deepEqual(received, [0]);
  sockets.shift();
  assert.equal(delivery.hasRecipient(), false);
});
