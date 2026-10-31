import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCatId } from '@cat-cafe/shared';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  QueueProcessor,
  type QueueProcessorDeps,
} from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { readQueueTargetExecution } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { RouteOptions } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import type { RouteStrategyDeps } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { dotProactiveFixture as fixture } from './helpers/f247-dot-proactive-fixture.js';

for (const publication of ['explicit-callback', 'stream'] as const) {
  test(`real QueueProcessor execution automatically returns a ${publication} answer with its current child`, async () => {
    const turns = new InMemoryTurnExecutionStore();
    const f = await fixture({ turnExecutionStore: turns });
    const tracker = new InvocationTracker();
    try {
      const thread = f.thread(publication);
      const ask = await f.ask(thread.id);
      const rootId = ask.result.structuredContent.messageId as string;
      let child: Awaited<ReturnType<typeof f.registry.create>> | undefined;
      const create = f.registry.create.bind(f.registry);
      f.registry.create = async (...args) => {
        child = await create(...args);
        return child;
      };

      const deps = {
        services: {
          codex: {
            async *invoke() {
              assert.ok(child, 'the real router must create an authenticated child');
              const accepted = await readQueueTargetExecution(
                f.messages,
                f.queue,
                f.messages.getById(rootId)!,
                'codex',
              );
              assert.equal(accepted?.kind, 'response');
              assert.equal(accepted?.kind === 'response' && accepted.response.invocationId, child.invocationId);
              if (publication === 'explicit-callback') {
                const posted = await f.app.inject({
                  method: 'POST',
                  url: '/api/callbacks/post-message',
                  headers: { 'x-invocation-id': child.invocationId, 'x-callback-token': child.callbackToken },
                  payload: { content: '实际执行回信', targetCats: ['gpt-dot'] },
                });
                assert.equal(posted.statusCode, 200, posted.payload);
              } else yield { type: 'text', catId: 'codex', content: '实际执行回信', timestamp: Date.now() };
              yield { type: 'done', catId: 'codex', timestamp: Date.now() };
            },
          },
        },
        invocationDeps: {
          registry: f.registry,
          turnExecutionStore: turns,
          sessionManager: {
            get: async () => null,
            getOrCreate: async () => ({}),
            resolveWorkingDirectory: () => '/tmp/test',
          },
          apiUrl: 'http://127.0.0.1:3102',
        },
        messageStore: f.messages,
        dotReplyTarget: (source) => f.asks.replyTarget(source),
      } as unknown as RouteStrategyDeps;
      const router: QueueProcessorDeps['router'] = {
        resolveExplicitTargets: async (targets) => [...targets],
        async *routeExecution(userId, content, threadId, _messageId, targets, _intent, options) {
          yield* routeSerial(deps, targets.map(createCatId), content, userId, threadId, {
            ...(options as RouteOptions),
          });
        },
        ackCollectedCursors: async () => {},
      };
      const processor = new QueueProcessor({
        queue: f.queue,
        invocationTracker: tracker,
        invocationRecordStore: f.records,
        router,
        socketManager: f.socket,
        messageStore: f.messages,
        turnExecutionStore: turns,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });
      // This fixture consumes only the asked member; external delivery is asserted below.
      processor.requestDrain = async () => {};
      assert.equal((await processor.processNext(thread.id, 'owner')).started, true);
      const deadline = Date.now() + 5000;
      let answer = f.messages.getByThread(thread.id).find((m) => m.content === '实际执行回信');
      while (!answer && Date.now() < deadline) {
        await delay(10);
        answer = f.messages
          .getByThread(thread.id, undefined, 'owner', { includeQueuedCatMessages: true })
          .find((m) => m.content === '实际执行回信');
      }
      assert.ok(answer, 'the actually executed entry must publish its response');
      assert.ok(child);
      assert.equal(
        answer.extra?.turnExecution?.invocationId ?? answer.extra?.stream?.turnInvocationId,
        child.invocationId,
      );
      const accepted = await readQueueTargetExecution(f.messages, f.queue, f.messages.getById(rootId)!, 'codex');
      assert.equal(accepted?.kind, 'response');
      assert.equal(
        accepted?.kind === 'response' && accepted.response.invocationId,
        child.invocationId,
        'delivery exercises the exact accepted child, including after its slot retires',
      );
      assert.deepEqual(answer.mentions, ['gpt-dot']);
      assert.equal((await f.deliver(answer.id)).kind, 'sent');
      assert.equal(f.events.length, 1);
      tracker.cancelInvocation(thread.id, ['codex', 'gpt-dot'], 'owner');
    } finally {
      await f.close();
    }
  });
}
