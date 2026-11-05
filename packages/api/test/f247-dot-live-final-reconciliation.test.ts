import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { CodexLiveRunPort } from '../src/domains/cats/services/agents/providers/CodexLiveRunPort.js';
import type { RouteStrategyDeps } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import type { DotReplyCandidate } from '../src/domains/cats/services/cloud-bridge/dot/dot-reply-authority.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { dotLiveQueueProcessor } from './helpers/f247-dot-live-lifecycle.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const carrier of ['ordinary', 'live'] as const) {
  for (const ending of ['tool-only', 'provider-final', 'provider-error', 'a2a-provider-final'] as const) {
    test(`a full-read dot Ask survives real ${carrier} final reconciliation: ${ending}`, async () => {
      const turns = new InMemoryTurnExecutionStore();
      const f = await dotProactiveFixture({ turnExecutionStore: turns, messageDisposition: 'continue_current' });
      try {
        const thread = f.thread(ending);
        const from =
          ending === 'a2a-provider-final'
            ? { kind: 'agent' as const, catId: createCatId('sonnet') }
            : { kind: 'user' as const, userId: 'owner' };
        const admitted = await f.queue.send(
          f.messages,
          {
            userId: 'owner',
            threadId: thread.id,
            from,
            content: 'deployment ready',
            mentions: [],
            timestamp: Date.now(),
            deliveryStatus: 'queued',
          },
          {
            userId: 'owner',
            threadId: thread.id,
            from,
            content: 'deployment ready',
            kind: from.kind === 'agent' ? 'message_wake' : 'conversation_input',
            ownerAuthProvenance: 'strict',
            targetCats: ['codex'],
            intent: 'execute',
          },
        );
        assert.equal(admitted.outcome, 'enqueued');
        assert.ok(admitted.outcome === 'enqueued' && admitted.entry);
        const trigger = admitted.message;
        let child: Awaited<ReturnType<typeof f.registry.create>> | undefined;
        const create = f.registry.create.bind(f.registry);
        f.registry.create = async (...args) => {
          child = await create(...args);
          return child;
        };
        let askId: string | undefined;
        let answerId: string | undefined;
        const routeEvents: unknown[] = [];
        const live: CodexLiveRunPort = {
          finished: Promise.resolve(),
          ready: async () => {},
          observe: async () => {},
        };
        const deps = {
          services: {
            codex: {
              freshnessCarrierCapability: () => f.carrierCapability,
              async *invoke() {
                assert.ok(child);
                const execution = turns.get(child.invocationId);
                assert.equal(
                  execution?.queueCompletionPolicy,
                  carrier === 'live' ? 'explicit_source' : undefined,
                  'invokeSingleCat must derive Live policy from its actual Host port',
                );
                assert.equal(execution?.causal?.triggerMessageId, trigger.id);
                const ask = await f.ask(thread.id, 'incoming-during-live');
                const rootId = ask.result.structuredContent.messageId as string;
                askId = rootId;
                if (carrier === 'ordinary') {
                  const read = await f.app.inject({
                    method: 'GET',
                    url: `/api/callbacks/thread-context?messageId=${rootId}&before=0&after=0&responseMode=full`,
                    headers: { 'x-invocation-id': child.invocationId, 'x-callback-token': child.callbackToken },
                  });
                  assert.equal(read.statusCode, 200, read.body);
                  assert.ok(
                    read.json().messages.some((message: { id: string }) => message.id === rootId),
                    read.body,
                  );
                  assert.ok(
                    f.messages.getById(rootId)?.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === 'codex'),
                    JSON.stringify(f.messages.getById(rootId)),
                  );
                } else {
                  const entry = f.queue.list(thread.id, 'owner').find((item) => item.payload.messageId === rootId);
                  assert.ok(entry);
                  assert.equal(
                    (
                      await processor.adoptExposedQueuedEntries({
                        threadId: thread.id,
                        userId: 'owner',
                        catId: 'codex',
                        invocationId: child.invocationId,
                        entries: [{ entryId: entry.id, messageId: rootId }],
                      })
                    ).outcome,
                    'adopted',
                  );
                }
                const payload = { content: 'the exact live answer', replyTo: rootId, targetCats: ['gpt-dot'] };
                const posted = await f.app.inject({
                  method: 'POST',
                  url: '/api/callbacks/post-message',
                  headers: { 'x-invocation-id': child.invocationId, 'x-callback-token': child.callbackToken },
                  payload,
                });
                assert.equal(posted.statusCode, 200, posted.payload);
                answerId = posted.json().messageId as string;
                assert.equal(f.messages.getById(answerId)?.extra?.causal?.triggerMessageId, askId);
                assert.deepEqual(f.messages.getById(answerId)?.mentions, ['gpt-dot']);
                yield {
                  type: 'tool_use',
                  catId: 'codex',
                  toolName: 'mcp__cat-cafe-collab__cat_cafe_post_message',
                  toolUseId: 'canonical-final',
                  toolInput: payload,
                  timestamp: Date.now(),
                };
                yield {
                  type: 'tool_result',
                  catId: 'codex',
                  toolUseId: 'canonical-final',
                  content: JSON.stringify({ status: 'ok', messageId: answerId, threadId: thread.id }),
                  timestamp: Date.now(),
                };
                if (ending === 'provider-final' || ending === 'a2a-provider-final')
                  yield { type: 'text', catId: 'codex', content: payload.content, timestamp: Date.now() };
                if (ending === 'provider-error')
                  yield {
                    type: 'error',
                    catId: 'codex',
                    content: 'provider closed after its committed final',
                    timestamp: Date.now(),
                  };
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
          dotReplyTarget: (source: DotReplyCandidate) => f.asks.replyTarget(source),
        } as unknown as RouteStrategyDeps;
        const { processor, tracker } = dotLiveQueueProcessor(
          f,
          {
            resolveExplicitTargets: async (targets) => [...targets],
            resolveConversationTargetsAtAdmission: async (targets) => [...targets],
            ackCollectedCursors: async () => {},
            async *routeExecution(userId, content, threadId, messageId, targets, _intent, options) {
              for await (const message of routeSerial(deps, targets.map(createCatId), content, userId, threadId, {
                ...options,
                currentUserMessageId: messageId ?? undefined,
                ...(carrier === 'live' ? { liveCompanion: live } : {}),
              })) {
                routeEvents.push(message);
                yield message;
              }
            },
          },
          turns,
        );
        // Cloud delivery is exercised explicitly below; keep its local slot occupied meanwhile.
        tracker.start(thread.id, 'gpt-dot', 'owner', ['gpt-dot'], 'cloud-delivery-fixture');
        const finished = new Promise<void>((resolve) => {
          processor.registerEntryCompleteHook(admitted.entry!.id, () => resolve(), 'codex');
        });
        assert.equal((await processor.processNext(thread.id, 'owner')).started, true);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            finished,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error('Live Queue execution did not finish')), 5000);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
          tracker.complete(thread.id, 'gpt-dot');
        }
        assert.ok(answerId, JSON.stringify({ routeEvents, execution: child && turns.get(child.invocationId) }));
        assert.ok(askId);
        assert.ok(child);
        const final = f.messages.getById(answerId);
        assert.ok(final);
        assert.equal(final.toolEvents, undefined, 'an explicit post retains its independent body');
        const source = f.messages.getById(askId);
        const responseId = source?.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === 'codex')?.statusMessageId;
        assert.ok(responseId);
        assert.notEqual(responseId, answerId);
        const response = f.messages.getById(responseId);
        assert.equal(response?.lifecycle?.kind, 'response');
        assert.equal(response?.lifecycle?.status, ending === 'provider-error' ? 'failed' : 'completed');
        assert.ok(response?.lifecycle?.inputMessageIds.includes(askId));
        assert.equal(response.toolEvents?.length, 2, 'the canonical response reaches final reconciliation');
        assert.equal((await f.deliver(answerId)).kind, 'sent', 'delivery occurs after final reconciliation');
        assert.equal(f.events.length, 1);
        assert.equal(f.events[0]?.data.source_message_id, answerId);
        assert.equal(final.extra?.causal?.triggerMessageId, askId);
        assert.equal(final.replyTo, askId);
        assert.equal(final.extra?.turnExecution?.invocationId, child.invocationId);
        assert.equal(turns.get(child.invocationId)?.causal?.triggerMessageId, trigger.id);
      } finally {
        await f.close();
      }
    });
  }
}
