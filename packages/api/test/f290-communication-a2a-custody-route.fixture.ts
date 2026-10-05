import assert from 'node:assert/strict';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import type { AgentMessage, AgentService, AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { callbackCustodyFixture, DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

export type ScopeCase = 'private' | 'public' | 'delegated-private' | 'home';
export type DeferCase = 'busy' | 'pending' | 'interrupted';

/** Actual AgentRouter strategy dependencies and routeSerial/invokeSingleCat; only the provider emits fixture text. */
export async function routeCustodyFixture(scope: ScopeCase, defer: DeferCase) {
  const f = await callbackCustodyFixture();
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  let catId = CAT;
  let threadId = f.task.threadId;
  const sourceId = await f.registry.verify(f.auth.invocationId, f.auth.callbackToken);
  assert.ok(sourceId.ok && sourceId.record.originTriggerMessageId);
  let triggerId = sourceId.record.originTriggerMessageId;
  if (scope === 'delegated-private') {
    const delegated = await f.firstHop();
    catId = DELEGATE;
    triggerId = delegated.source.id;
  } else if (scope === 'public') {
    const binding = sourceId.record.collectiveWorkBinding;
    assert.ok(binding);
    assert.ok(binding.sourceRef.startsWith('message:'));
    triggerId = binding.sourceRef.slice('message:'.length);
    const source = await f.messages.getById(triggerId);
    assert.ok(source?.source?.connector === 'collective');
    threadId = source.threadId;
    assert.ok(
      await f.context.resolvePublic({ userId: f.cafe.ownerUserId, threadId, catId, originTriggerMessageId: triggerId }),
    );
  } else if (scope === 'home') {
    threadId = f.threads.create(f.cafe.ownerUserId, 'Ordinary text routing control').id;
    triggerId = f.messages.append({
      userId: f.cafe.ownerUserId,
      threadId,
      catId: null,
      content: 'Ordinary home request',
      mentions: [],
      timestamp: Date.now(),
    }).id;
  }
  const controller = tracker.startAll(threadId, [catId], f.cafe.ownerUserId, 'fixture-text-emitter');
  assert.ok(controller);
  if (defer === 'busy') tracker.startAll(threadId, [NEXT_CAT], f.cafe.ownerUserId, 'fixture-occupied-target');
  const calls: { catId: string; policy?: string }[] = [];
  const service: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt: string, options?: AgentServiceOptions) {
      calls.push({ catId, policy: options?.toolExecutionPolicy?.mode });
      yield {
        type: 'text',
        catId,
        content: `@${NEXT_CAT}\nFixture provider output asks for another Cat`,
        timestamp: Date.now(),
      };
      if (defer === 'interrupted') controller.abort(new Error('Fixture interruption after text emission'));
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
  const other: AgentService = {
    supportsToolExecutionPolicy: () => true,
    async *invoke() {
      calls.push({ catId: NEXT_CAT });
      yield { type: 'done', catId: NEXT_CAT, timestamp: Date.now() };
    },
  };
  const agents = new AgentRegistry();
  agents.register(catId, service);
  agents.register(NEXT_CAT, other);
  const router = new AgentRouter({
    registry: f.registry,
    agentRegistry: agents,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    collectiveContext: () => f.context,
  });
  const run = async () => {
    const events: AgentMessage[] = [];
    for await (const event of routeSerial(
      router.getStrategyDeps(),
      [catId],
      'Fixture text routing',
      f.cafe.ownerUserId,
      threadId,
      {
        currentUserMessageId: triggerId,
        ownerAuthProvenance: 'unknown',
        ...(scope === 'private' ? { executionScope: 'collective-work' as const } : {}),
        ...(scope === 'public' ? { executionScope: 'collective-participation' as const } : {}),
        signal: controller.signal,
        invocationController: controller,
        queueHasQueuedMessages: () => defer === 'pending',
        deferA2AEnqueue: (entry) => queue.enqueue(entry),
        trackA2ASlot: (tid, target, user, owner) => tracker.trackExternalSlot(tid, target, owner, user, [target]),
        completeA2ASlots: (tid, cats, owner) => {
          for (const target of cats) tracker.completeSlot(tid, target, owner);
        },
      },
    ))
      events.push(event);
    return events;
  };
  return {
    ...f,
    queue,
    calls,
    catId,
    threadId,
    run,
    async close() {
      tracker.cancelAll(threadId);
      await f.close();
    },
  };
}
