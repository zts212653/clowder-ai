import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { HomeHubDelivery } from '../src/domains/concierge/live/host/home/home-hub-delivery.js';

const artifact = { contentRef: `prepared-media:${'a'.repeat(64)}`, ownerRevision: 1 };
function fixture() {
  const clientId = randomUUID();
  let clientToken = '';
  let receive: (token: string) => Promise<unknown[]> = async () => [];
  const hub = new HomeHubDelivery({
    messages: new MessageStore(),
    threads: new ThreadStore(),
    isCurrent: async () => true,
    emitter: {
      emit: () => {},
      emitWithAck: async (_owner, event, data) =>
        event === 'home:inspect'
          ? [{ clientId, clientToken, route: '/', threadId: 'source', composer: false, sections: [] }]
          : receive((data as { token: string }).token),
    },
  });
  clientToken = hub.registerClient('owner', clientId).clientToken;
  const source = {
    kind: 'message' as const,
    threadId: 'source',
    messageId: 'original',
    messageRevision: '1',
    item: { kind: 'content-block' as const, index: 0 },
    expectedUrl: '/uploads/original.txt',
  };
  return {
    hub,
    clientId,
    clientToken,
    source,
    receive(fn: typeof receive) {
      receive = fn;
    },
  };
}
test('work opens pass the original item and exact version through the existing owner window capability', async () => {
  const f = fixture();
  f.receive(async (token) => {
    const grant = await f.hub.consume('owner', token, f.clientId, f.clientToken);
    assert.deepEqual((grant as { action: unknown }).action, { kind: 'publication', source: f.source, artifact });
    assert.deepEqual(await f.hub.consume('owner', token, f.clientId, f.clientToken), {
      kind: 'blocked',
      reason: 'already_consumed',
    });
    return [{ token, clientId: f.clientId, clientToken: f.clientToken, status: 'applied', artifact }];
  });
  assert.equal(
    await f.hub.openWork(
      'owner',
      async () => ({ source: f.source, artifact }),
      async () => {},
    ),
    'applied',
  );
});
test('an emitted event or a different displayed version cannot prove work.open applied', async () => {
  const f = fixture();
  assert.equal(
    await f.hub.openWork(
      'owner',
      async () => ({ source: f.source, artifact }),
      async () => {},
    ),
    'unconfirmed',
  );
  f.receive(async (token) => {
    await f.hub.consume('owner', token, f.clientId, f.clientToken);
    return [
      {
        token,
        clientId: f.clientId,
        clientToken: f.clientToken,
        status: 'applied',
        artifact: { ...artifact, ownerRevision: 2 },
      },
    ];
  });
  assert.equal(
    await f.hub.openWork(
      'owner',
      async () => ({ source: f.source, artifact }),
      async () => {},
    ),
    'unconfirmed',
  );
});
test('revocation before the owner consumes a work request prevents the grant and rejects a forged applied ACK', async () => {
  const f = fixture();
  let current = true;
  f.receive(async (token) => {
    current = false;
    assert.deepEqual(await f.hub.consume('owner', token, f.clientId, f.clientToken), { kind: 'blocked' });
    return [{ token, clientId: f.clientId, clientToken: f.clientToken, status: 'applied', artifact }];
  });
  assert.equal(
    await f.hub.openWork(
      'owner',
      async () => ({ source: f.source, artifact }),
      async () => {
        if (!current) throw new Error('revoked');
      },
    ),
    'blocked',
  );
});

test('a lease cancellation during work delivery sends the existing cancellation and refuses a late ACK', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.receive(async (token) => {
    controller.abort('revoked');
    assert.deepEqual(await f.hub.consume('owner', token, f.clientId, f.clientToken), { kind: 'blocked' });
    return [{ token, clientId: f.clientId, clientToken: f.clientToken, status: 'applied', artifact }];
  });
  assert.equal(
    await f.hub.openWork(
      'owner',
      async () => ({ source: f.source, artifact }),
      async () => {},
      controller.signal,
    ),
    'blocked',
  );
});
