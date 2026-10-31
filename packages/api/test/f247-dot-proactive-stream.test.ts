import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import type { RouteStrategyDeps } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import { commitCompletedResponseAndEnqueueA2ATargets } from '../src/routes/callback-a2a-trigger.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';
import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

test('formal streamed answers without an @ return through existing durable Queue admission', async () => {
  const f = await dotProactiveFixture();
  try {
    if (!catRegistry.has('gpt-dot'))
      catRegistry.register('gpt-dot', {
        ...catRegistry.getOrThrow('codex').config,
        id: createCatId('gpt-dot'),
        clientId: 'openai',
        provider: 'openai-chatgpt-pro',
        cli: undefined,
        mentionPatterns: ['@dot'],
        displayName: 'test dot',
      });
    const thread = f.thread('stream');
    const response = await f.ask(thread.id);
    assert.ok(response.result, JSON.stringify(response));
    const rootId = response.result.structuredContent.messageId as string;
    let responseId: string | undefined;
    const deps = {
      services: {
        codex: {
          async *invoke() {
            yield { type: 'text', catId: 'codex', content: '正式流式回答，没有点名任何猫。', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'stream-answer', callbackToken: 'test' }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
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
    for await (const _ of routeSerial(deps, [createCatId('codex')], 'answer', 'owner', thread.id, {
      a2aTriggerMessageId: rootId,
      onLifecycleInvocationStarted: async (input) => {
        const response = await appendTestLifecycleResponseSource(f.messages, {
          invocationId: input.invocationId,
          catId: input.catId,
          threadId: input.threadId,
          userId: input.userId,
          timestamp: input.startedAt,
        });
        responseId = response.id;
        if (response.lifecycle?.kind === 'response') response.lifecycle.inputMessageIds = [rootId];
        const root = f.messages.getById(rootId)!;
        f.messages.advanceLifecycleInputDispatch(rootId, {
          kind: 'input',
          orderKey: root.lifecycle!.orderKey,
          targetId: 'codex',
          phase: 'dispatched',
          statusMessageId: response.id,
          dispatchedAt: input.startedAt,
        });
        return {
          responseMessageId: response.id,
          priorFrontierMessageId: null,
          activeRun: {
            threadId: input.threadId,
            targetId: input.catId,
            invocationId: input.invocationId,
            responseMessageId: response.id,
            inputEntryIds: [],
            inputMessageIds: [rootId],
            privateInputEntryIds: [],
            startedAt: input.startedAt,
          },
        };
      },
      commitCompletedA2AWake: (input) =>
        commitCompletedResponseAndEnqueueA2ATargets(
          {
            messageStore: f.messages,
            invocationQueue: f.queue,
            queueProcessor: { async requestDrain() {} },
            socketManager: f.socket,
            log: { info() {}, warn() {}, error() {} },
          } as never,
          input,
        ),
    })) {
      /* consume formal output */
    }
    const answer = f.messages
      .getByThread(thread.id, undefined, 'owner', { includeQueuedCatMessages: true })
      .find((m) => m.content.startsWith('正式流式回答'));
    assert.ok(answer, 'formal output must be durable');
    assert.deepEqual(answer.mentions, ['gpt-dot']);
    assert.equal(answer.extra?.causal?.triggerMessageId, rootId);
    const entry = f.queue.list(thread.id, 'owner').find((e) => e.targets.includes('gpt-dot'));
    assert.ok(entry, 'automatic return must not depend on an explicit text mention');
    assert.equal(entry.payload.messageId, answer.id);
    assert.equal(answer.id, responseId);
    assert.equal(answer.lifecycle?.kind, 'response');
    assert.equal(answer.lifecycle?.status, 'completed');

    assert.equal((await f.deliver(answer.id)).kind, 'sent');
  } finally {
    await f.close();
  }
});
