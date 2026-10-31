import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveSubexecutionLog } from '../src/domains/concierge/live/live-subexecution-log.js';

for (const { childCompletes, recordFailure } of [
  { childCompletes: true, recordFailure: false },
  { childCompletes: false, recordFailure: false },
  { childCompletes: false, recordFailure: true },
]) {
  test(`the actual Live client publishes child facts once and drains unfinished children (completed=${childCompletes},recordFailure=${recordFailure})`, async () => {
    const queue: unknown[] = [];
    let waiter: ((result: IteratorResult<unknown>) => void) | undefined;
    let closed = false;
    let terminated = false;
    const push = (value: unknown) => {
      if (waiter) {
        const receive = waiter;
        waiter = undefined;
        receive({ value, done: false });
      } else queue.push(value);
    };
    const wire = {
      read: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<unknown>> => {
            if (queue.length) return { value: queue.shift(), done: false };
            if (closed) return { value: undefined, done: true };
            return new Promise((resolve) => {
              waiter = resolve;
            });
          },
        }),
      }),
      write: async (message: Record<string, unknown>) => {
        const params = message.params as Record<string, unknown> | undefined;
        if (message.method === 'initialize') push({ id: message.id, result: {} });
        if (message.method === 'config/read')
          push({ id: message.id, result: { config: { model_provider: 'openai' } } });
        if (message.method === 'configRequirements/read') push({ id: message.id, result: { requirements: null } });
        if (message.method === 'account/read') push({ id: message.id, result: { account: { type: 'chatgpt' } } });
        if (message.method === 'thread/start') push({ id: message.id, result: { thread: { id: 'root' } } });
        if (message.method === 'thread/read')
          push({
            id: message.id,
            result: {
              thread: {
                id: params?.threadId,
                source: { subAgent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } },
              },
            },
          });
        if (message.method === 'turn/start') {
          push({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
          push({
            method: 'item/started',
            params: {
              threadId: 'root',
              turnId: 'turn',
              item: {
                type: 'subAgentActivity',
                kind: 'started',
                id: 'activity',
                agentThreadId: 'child',
                agentPath: '/root/reader',
              },
            },
          });
          push({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
          push({
            method: 'item/completed',
            params: {
              threadId: 'child',
              turnId: 'child-turn',
              item: { type: 'agentMessage', phase: 'final_answer', id: 'child-result', text: 'two different reports' },
            },
          });
          if (childCompletes)
            push({
              method: 'turn/completed',
              params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } },
            });
          push({ method: 'turn/completed', params: { threadId: 'root', turn: { id: 'turn', status: 'completed' } } });
        }
      },
      close: async () => {
        closed = true;
        waiter?.({ value: undefined, done: true });
        waiter = undefined;
      },
      terminate: async () => {
        terminated = true;
        closed = true;
        waiter?.({ value: undefined, done: true });
        waiter = undefined;
      },
    };
    const store = new MessageStore();
    if (recordFailure)
      store.appendIdempotent = async () => {
        throw new Error('fixture-store-secret');
      };
    const log = new LiveSubexecutionLog({
      scope: { userId: 'owner', threadId: 'home', catId: createCatId('codex61-sol'), callId: 'call' },
      rootThread: () => 'root',
      available: () => true,
      verify: async () => true,
      store,
      publish() {},
    });
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const live = {
      finished,
      ready: async () => {},
      acceptsInput: () => true,
      observe: async (event: Record<string, unknown>) => {
        const params = event.params as Record<string, unknown> | undefined;
        const turn = params?.turn as { id?: string } | undefined;
        if (event.method === 'turn/started' && turn?.id) log.rootStarted('root', turn.id);
        if (event.method === 'turn/completed') finish();
      },
      observeSubexecution: log.observe.bind(log),
    };
    const client = new CodexAppServerClient({ wire, requestTimeoutMs: 1000 });
    const rootEvents: unknown[] = [];
    const consume = async () => {
      for await (const event of client.run({
        prompt: { kind: 'frozen', prompt: 'supplied material only' },
        thread: { kind: 'start' },
        model: 'test-model',
        live,
        timeoutMs: 1000,
      }))
        rootEvents.push(event);
    };
    if (recordFailure) {
      await assert.rejects(consume(), /Live native child usage history unavailable/);
      assert.ok(!JSON.stringify(rootEvents).includes('fixture-store-secret'));
    } else await consume();
    assert.equal(
      (await store.getByThread('home')).filter(
        (message) => message.metadata?.subexecutionEvents?.[0]?.kind === 'subexecution',
      ).length,
      recordFailure ? 0 : childCompletes ? 4 : 3,
    );
    assert.equal(terminated, !childCompletes, 'an unfinished child cannot survive in a returned warm Host');
    assert.equal(
      rootEvents.some(
        (event) =>
          typeof event === 'object' && event !== null && 'type' in event && event.type === 'app_server.subexecution',
      ),
      false,
      'child facts already published through the Host cannot also become root collector text',
    );
    log.close();
  });
}
