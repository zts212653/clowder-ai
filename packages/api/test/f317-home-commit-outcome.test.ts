import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { HomeHubDelivery } from '../src/domains/concierge/live/host/home/home-hub-delivery.js';

for (const boundary of ['abort', 'unregister', 'expiry', 'close', 'blocked-ack', 'abort-after-ack'] as const) {
  test(`a real draft CAS committed during ${boundary} retains its committed grant and never reports blocked`, async (t) => {
    const messages = new MessageStore();
    const threads = new ThreadStore();
    const thread = threads.create('owner', '/project');
    const controller = new AbortController();
    const state = {
      clientId: randomUUID(),
      clientToken: '',
      route: '/',
      threadId: thread.id,
      composer: true,
      sections: [],
    };
    const now = Date.now();
    let clock = now;
    t.mock.method(Date, 'now', () => clock);
    let grant: unknown;
    const hub = new HomeHubDelivery({
      messages: {
        getOwnerComposerDraft: (...args) => messages.getOwnerComposerDraft(...args),
        putOwnerComposerDraft: async (...args) => {
          const committed = messages.putOwnerComposerDraft(...args);
          if (boundary === 'abort' || boundary === 'abort-after-ack') controller.abort();
          if (boundary === 'unregister') hub.unregisterClient('owner', state.clientId, state.clientToken);
          if (boundary === 'expiry') clock += 11_000;
          if (boundary === 'close') hub.close();
          return committed;
        },
      },
      threads,
      isCurrent: async () => true,
      emitter: {
        emit: () => {},
        emitWithAck: async (_owner, event, data) => {
          if (event === 'home:inspect') return [state];
          const token = (data as { token: string }).token;
          const consumed = hub.consume('owner', token, state.clientId, state.clientToken, 0);
          if (boundary === 'abort-after-ack') {
            void consumed.then((result) => {
              grant = result;
            });
            return [{ token, clientId: state.clientId, clientToken: state.clientToken, status: 'applied' }];
          }
          grant = await consumed;
          return [{ token, clientId: state.clientId, clientToken: state.clientToken, status: 'blocked' }];
        },
      },
    });
    state.clientToken = hub.registerClient('owner', state.clientId).clientToken;
    try {
      const request = {
        userId: 'owner',
        callId: 'call',
        messageId: 'source',
        revision: '1',
        text: '在输入框写入「带伞」',
        signal: controller.signal,
      };
      const target = (await hub.targets(request)).find((x) => x.ownerAction.kind === 'draft');
      assert.ok(target);
      const result = await hub.execute(request, target, {
        kind: 'act',
        targetId: target.id,
        operation: 'fill',
        value: '带伞',
      });
      assert.equal(messages.getOwnerComposerDraft('owner', thread.id)?.text, '带伞');
      assert.equal((grant as { kind: string }).kind, 'updated', 'cancellation cannot erase the actual committed CAS');
      assert.equal(result.status, 'unconfirmed', 'the durable write is known; display is unconfirmed, not denied');
      assert.deepEqual(messages.getByThread(thread.id), [], 'draft insertion never sends a message');
    } finally {
      hub.close();
    }
  });
}
