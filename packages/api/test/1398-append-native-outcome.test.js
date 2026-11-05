import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';

test(
  'Codex negative RPC reply remains uncertain and keeps exact late consumption observation',
  { timeout: 5000 },
  async () => {
    const values = [];
    let waiter;
    let closed = false;
    const push = (value) => {
      if (waiter) {
        const take = waiter;
        waiter = undefined;
        take({ value, done: false });
      } else values.push(value);
    };
    const close = () => {
      closed = true;
      waiter?.({ done: true });
    };
    const writes = [];
    let readItemClientId = 'other-input';
    const wire = {
      read: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            values.length
              ? Promise.resolve({ value: values.shift(), done: false })
              : closed
                ? Promise.resolve({ done: true })
                : new Promise((resolve) => {
                    waiter = resolve;
                  }),
        }),
      }),
      async write(message) {
        writes.push(message);
        if (message.id === undefined || !message.method) return;
        switch (message.method) {
          case 'initialize':
            return push({ id: message.id, result: {} });
          case 'thread/start':
            return push({ id: message.id, result: { thread: { id: 'native-thread' } } });
          case 'turn/start':
            return push({ id: message.id, result: { turn: { id: 'native-turn', status: 'inProgress' } } });
          case 'thread/items/list':
            assert.deepEqual(message.params, {
              threadId: 'native-thread',
              turnId: 'native-turn',
              limit: 50,
              sortDirection: 'desc',
            });
            return push({
              id: message.id,
              result: {
                data: [{ turnId: 'native-turn', item: { type: 'userMessage', clientId: readItemClientId } }],
                nextCursor: null,
              },
            });
          case 'turn/steer':
            return push({ id: message.id, error: { code: -32000, message: 'reply uncertain after handoff' } });
          default:
            assert.fail(`Unexpected native RPC in append fixture: ${message.method}`);
        }
      },
      terminate: async () => close(),
      close: async () => close(),
    };
    let dispatcher;
    let reads = 0;
    const client = new CodexAppServerClient({ wire });
    const run = (async () => {
      for await (const _event of client.run({
        prompt: { kind: 'frozen', prompt: 'initial' },
        thread: { kind: 'start' },
        activeRunDispatch: {
          invocationId: 'inv',
          register: (value) => {
            dispatcher = value;
          },
        },
      })) {
      }
    })();
    const waitFor = async (predicate) => {
      for (let i = 0; i < 200 && !predicate(); i++) await delay(2);
      assert.ok(predicate());
    };
    try {
      await waitFor(() => dispatcher);
      const result = await dispatcher.dispatch(
        {
          text: 'original input',
          messageIds: ['source'],
          deliveryId: '00000000-0000-4000-8000-000000000001',
          onInputRead: async () => {
            reads++;
          },
        },
        { expectedInvocationId: 'inv', force: false },
      );
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'provider_rejected');
      assert.equal(result.acceptance, 'unknown');
      const clientId = writes.find((message) => message.method === 'turn/steer').params.clientUserMessageId;
      assert.equal(clientId, '00000000-0000-4000-8000-000000000001');
      assert.equal(await dispatcher.inspectInput(clientId), 'unknown');
      readItemClientId = clientId;
      assert.equal(await dispatcher.inspectInput(clientId), 'accepted');
      assert.equal(writes.filter((message) => message.method === 'thread/items/list').length, 2);
      assert.equal(reads, 0, 'history evidence must not fabricate the late consumption notification');
      assert.equal(writes.filter((message) => message.method === 'turn/steer').length, 1);
      push({
        method: 'item/completed',
        params: {
          threadId: 'native-thread',
          turnId: 'native-turn',
          item: {
            type: 'userMessage',
            id: 'native-input',
            clientId,
            content: [{ type: 'text', text: 'original input' }],
          },
        },
      });
      await waitFor(() => reads === 1);
    } finally {
      push({
        method: 'turn/completed',
        params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'completed' } },
      });
      await run;
    }
    assert.equal(reads, 1, 'the exact late notification is consumed once after the run drains');
  },
);
