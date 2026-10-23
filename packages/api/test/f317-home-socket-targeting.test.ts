import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { io, type Socket } from 'socket.io-client';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { installHomeActions } from '../src/domains/concierge/live/host/home/install-home-actions.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { SocketManager } from '../src/infrastructure/websocket/SocketManager.js';

async function fixture() {
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'owner' });
  const manager = new SocketManager(app.server);
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', '/project');
  const service = await installHomeActions(app, {
    ownerUserId: 'owner',
    messages,
    threads,
    socketManager: manager,
    sessions: new LiveCompanionSessions(),
    registry: new InvocationRegistry(),
    isCurrentThread: async () => true,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const issued = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(issued.headers['set-cookie']).split(';')[0] };
  const sockets: Socket[] = [];
  async function connect(authenticated = true) {
    const client = io(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: authenticated ? { Cookie: headers.cookie } : {},
    });
    sockets.push(client);
    await once(client, 'connect');
    return client;
  }
  return {
    app,
    service,
    manager,
    headers,
    connect,
    thread,
    close: async () => {
      for (const socket of sockets) socket.disconnect();
      manager.close();
      await app.close();
    },
  };
}

test(
  'ordinary chat sockets without home ACK handlers do not delay the registered Home consumer',
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture();
    try {
      const home = await f.connect();
      const ordinary = await f.connect();
      let ordinaryEvents = 0;
      ordinary.onAny((event) => {
        if (event.startsWith('home:')) ordinaryEvents++;
      });
      const clientId = randomUUID();
      const register = (payload: unknown) =>
        f.app.inject({ method: 'POST', url: '/api/concierge/home/clients', headers: f.headers, payload });
      const old = await register({ clientId });
      const bound = await register({ clientId, socketId: home.id });
      const lease = bound.statusCode === 200 ? bound.json() : old.json();
      home.on('home:inspect', (_data, ack) =>
        ack({
          clientId,
          clientToken: lease.clientToken,
          route: '/',
          threadId: f.thread.id,
          composer: true,
          sections: [],
        }),
      );
      const start = performance.now();
      const targets = await f.service.hub.targets({
        userId: 'owner',
        callId: 'call',
        messageId: 'source',
        revision: '1',
        text: '在输入框写入「带伞」',
        signal: new AbortController().signal,
      });
      const elapsed = performance.now() - start;
      t.diagnostic(JSON.stringify({ elapsedMs: elapsed, registrationStatus: bound.statusCode, ordinaryEvents }));
      assert.ok(targets.length > 0, 'the original owner-issued capability remains usable');
      assert.equal(ordinaryEvents, 0, 'Home events are sent only to registered Home connections');
      assert.ok(elapsed < 750, 'a healthy Home ACK must not wait for a non-Home socket timeout');
      assert.equal(bound.statusCode, 200);
      home.on('home:execute', async (data, ack) => {
        const grant = await f.service.hub.consume('owner', data.token, clientId, lease.clientToken);
        assert.equal((grant as { kind: string }).kind, 'navigate');
        ack({ token: data.token, clientId, clientToken: lease.clientToken, status: 'unconfirmed' });
      });
      const deliveryStart = performance.now();
      const result = await f.service.hub.openWork(
        'owner',
        async () => ({
          source: {
            kind: 'message',
            threadId: f.thread.id,
            messageId: 'synthetic-source',
            messageRevision: '1',
            item: { kind: 'content-block', index: 0 },
            expectedUrl: '/uploads/synthetic.png',
          },
        }),
        async () => {},
      );
      assert.equal(result, 'unconfirmed');
      assert.ok(
        performance.now() - deliveryStart < 750,
        'execution ACK is also confined to the selected Home connection',
      );
      assert.equal(ordinaryEvents, 0);
    } finally {
      await f.close();
    }
  },
);

test('an owner HTTP session cannot bind a missing or foreign-session socket as its Home connection', async () => {
  const f = await fixture();
  try {
    const foreign = await f.connect(false);
    for (const socketId of ['missing-socket', foreign.id]) {
      const result = await f.app.inject({
        method: 'POST',
        url: '/api/concierge/home/clients',
        headers: f.headers,
        payload: { clientId: randomUUID(), socketId },
      });
      assert.equal(result.statusCode, 403);
    }
  } finally {
    await f.close();
  }
});

for (const registerAnotherWindow of [false, true]) {
  test(`an eight-hour Home socket renews through owner HTTP discovery${registerAnotherWindow ? ' after another window registers' : ''}`, async (t) => {
    const f = await fixture();
    const initialNow = Date.now();
    let now = initialNow;
    t.mock.method(Date, 'now', () => now);
    try {
      const home = await f.connect();
      const clientId = randomUUID();
      const register = () =>
        f.app.inject({
          method: 'POST',
          url: '/api/concierge/home/clients',
          headers: f.headers,
          payload: { clientId, socketId: home.id },
        });
      let lease = (await register()).json();
      const oldToken = lease.clientToken;
      let renewals = 0;
      home.on('home:inspect', async (_data, ack) => {
        if (lease.expiresAt <= Date.now()) {
          lease = (await register()).json();
          renewals++;
        }
        ack({
          clientId,
          clientToken: lease.clientToken,
          route: '/',
          threadId: f.thread.id,
          composer: true,
          sections: [],
        });
      });
      now = initialNow + 8 * 60 * 60 * 1000 + 1;
      assert.deepEqual(await f.service.hub.consume('owner', randomUUID(), clientId, oldToken), { kind: 'blocked' });
      if (registerAnotherWindow) {
        const other = await f.connect();
        const registered = await f.app.inject({
          method: 'POST',
          url: '/api/concierge/home/clients',
          headers: f.headers,
          payload: { clientId: randomUUID(), socketId: other.id },
        });
        assert.equal(registered.statusCode, 200);
        other.on('home:inspect', (_data, ack) => ack(null));
      }
      const targets = await f.service.hub.targets({
        userId: 'owner',
        callId: 'call',
        messageId: 'source',
        revision: '1',
        text: '在输入框写入「带伞」',
        signal: new AbortController().signal,
      });
      assert.ok(targets.length > 0, 'the healthy existing socket must be discoverable after its action token expires');
      assert.equal(renewals, 1);
      assert.notEqual(lease.clientToken, oldToken);
      assert.ok(lease.expiresAt > now);
      assert.equal(home.connected, true, 'no reload or connection lifecycle event was needed');
      home.on('home:execute', async (data, ack) => {
        assert.deepEqual(await f.service.hub.consume('owner', data.token, clientId, oldToken), { kind: 'blocked' });
        const grant = await f.service.hub.consume('owner', data.token, clientId, lease.clientToken);
        assert.equal(
          (grant as { kind: string }).kind,
          'navigate',
          'only the renewed capability can consume the real command',
        );
        ack({ token: data.token, clientId, clientToken: lease.clientToken, status: 'unconfirmed' });
      });
      assert.equal(
        await f.service.hub.openWork(
          'owner',
          async () => ({
            source: {
              kind: 'message',
              threadId: f.thread.id,
              messageId: 'synthetic-source',
              messageRevision: '1',
              item: { kind: 'content-block', index: 0 },
              expectedUrl: '/uploads/synthetic.png',
            },
          }),
          async () => {},
        ),
        'unconfirmed',
      );
    } finally {
      await f.close();
    }
  });
}

test('two authenticated Home sockets deliver a publication only to the selected page', async () => {
  const f = await fixture();
  try {
    const received: string[] = [];
    const home = await Promise.all([f.connect(), f.connect()]);
    const artifact = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 2 };
    for (const [index, socket] of home.entries()) {
      const clientId = randomUUID();
      const registered = await f.app.inject({
        method: 'POST',
        url: '/api/concierge/home/clients',
        headers: f.headers,
        payload: { clientId, socketId: socket.id },
      });
      assert.equal(registered.statusCode, 200);
      const clientToken = registered.json().clientToken;
      socket.on('home:inspect', (_data, ack) =>
        ack({
          clientId,
          clientToken,
          route: index === 0 ? '/' : '/settings',
          threadId: f.thread.id,
          composer: false,
          sections: [],
        }),
      );
      socket.on('home:execute', async (data, ack) => {
        received.push(clientId);
        const grant = await f.app.inject({
          method: 'POST',
          url: `/api/concierge/home/commands/${data.token}`,
          headers: f.headers,
          payload: { clientId, clientToken },
        });
        assert.equal(grant.json().kind, 'navigate');
        ack({ token: data.token, clientId, clientToken, status: 'applied', artifact });
      });
    }
    const discovery = await f.service.hub.pages.read('owner');
    assert.ok('pages' in discovery);
    assert.equal(discovery.pages.length, 2);
    const selected = discovery.pages.find((page) => page.state.route === '/settings');
    assert.ok(selected);
    const result = await f.service.hub.openWork(
      'owner',
      async () => ({
        source: {
          kind: 'message',
          threadId: f.thread.id,
          messageId: 'original-v2',
          messageRevision: '2',
          item: { kind: 'content-block', index: 0 },
          expectedUrl: '/uploads/v2.png',
        },
        artifact,
      }),
      async () => {},
      new AbortController().signal,
      selected,
    );
    assert.equal(result, 'applied');
    assert.deepEqual(received, [selected.state.clientId]);
    await f.app.inject({
      method: 'DELETE',
      url: `/api/concierge/home/clients/${selected.state.clientId}`,
      headers: f.headers,
      payload: { clientToken: selected.state.clientToken },
    });
    assert.equal(
      await f.service.hub.openWork(
        'owner',
        async () => null,
        async () => {},
        new AbortController().signal,
        selected,
      ),
      'blocked',
    );
    assert.equal(received.length, 1, 'losing the selected page never redirects to the other valid page');
  } finally {
    await f.close();
  }
});
