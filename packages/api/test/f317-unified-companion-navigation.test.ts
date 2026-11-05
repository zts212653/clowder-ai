import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  companionDecisionUrl,
  createCompanionDecisionNavigation,
  createCompanionDecisionSocketDelivery,
} from '../src/domains/concierge/live/host/unified/companion-decision-navigation.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';

function fixture(afterOpen?: () => void) {
  const messages = new MessageStore(),
    threads = new ThreadStore();
  const thread = threads.create('owner', 'project');
  const message = messages.append({
    threadId: thread.id,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    content: 'source',
    timestamp: 1,
    mentions: [],
    extra: { rich: { v: 1, blocks: [{ kind: 'card', v: 1, id: 'card', title: 'source' }] } },
  });
  let recipient = true,
    current = true,
    browserAvailable = true;
  const emitted: object[] = [];
  const opened: object[] = [];
  const ports = createCompanionDecisionNavigation({
    ownerUserId: 'owner',
    messages,
    threads,
    assertCurrent: async () => {
      if (!current) throw new Error('stale lease');
    },
    hasRecipient: () => recipient,
    openBrowser: async (destination) => {
      opened.push(destination);
      afterOpen?.();
      return browserAvailable;
    },
    emit: (destination) => {
      emitted.push(destination);
    },
  });
  const destination = { threadId: thread.id, messageId: message.id, blockId: 'card' };
  return {
    ports,
    destination,
    emitted,
    opened,
    message,
    thread,
    disconnect: () => {
      recipient = false;
    },
    revoke: () => {
      current = false;
    },
    failBrowser: () => {
      browserAvailable = false;
    },
  };
}

test('the native link retains the exact approval coordinates at the Host configured origin', () => {
  assert.equal(
    companionDecisionUrl(
      { threadId: 'thread-owner', messageId: 'message-source', blockId: 'approval-card' },
      'http://localhost:5511',
    ),
    'http://localhost:5511/thread/thread-owner?message=message-source&block=approval-card',
  );
  assert.equal(
    companionDecisionUrl({ threadId: 'thread-owner', messageId: 'message-source' }, 'http://localhost:5511'),
    'http://localhost:5511/thread/thread-owner?message=message-source',
  );
});

test('navigation delivers only a persisted owner source and its real block through the owner port', async () => {
  const f = fixture();
  assert.equal(await f.ports.canOpenDecision(f.destination), true);
  assert.equal(await f.ports.openDecision(f.destination), true);
  assert.deepEqual(f.emitted, [f.destination]);
  assert.deepEqual(f.opened, [f.destination]);
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
  assert.deepEqual(f.opened, []);
});

test('a closed Hub still opens the exact source in the foreground browser', async () => {
  const f = fixture();
  f.disconnect();
  assert.equal(await f.ports.openDecision(f.destination), true);
  assert.deepEqual(f.opened, [f.destination]);
  assert.deepEqual(f.emitted, []);
});

test('browser failure stays unconfirmed and a stale lease cannot open or emit', async () => {
  const f = fixture();
  f.failBrowser();
  assert.equal(await f.ports.openDecision(f.destination), false);
  assert.deepEqual(f.emitted, []);
  f.opened.length = 0;
  f.revoke();
  await assert.rejects(f.ports.openDecision(f.destination), /stale lease/);
  assert.deepEqual(f.emitted, []);
  assert.deepEqual(f.opened, []);
});

test('revocation while the OS opens the browser prevents a later socket delivery', async () => {
  const f = fixture(() => f.revoke());
  await assert.rejects(f.ports.openDecision(f.destination), /stale lease/);
  assert.deepEqual(f.opened, [f.destination]);
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
