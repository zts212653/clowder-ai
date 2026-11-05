import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { CodexLiveRunPort } from '../src/domains/cats/services/agents/providers/CodexLiveRunPort.js';
import type { RouteStrategyDeps } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import type { DotReplyCandidate } from '../src/domains/cats/services/cloud-bridge/dot/dot-reply-authority.js';
import { FreshnessOutputCommitCoordinator } from '../src/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { dotLiveQueueProcessor } from './helpers/f247-dot-live-lifecycle.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const carrier of ['ordinary', 'live'] as const) {
  for (const ending of [
    'provider-final',
    'a2a-provider-final',
    'mentioned-final',
    'late-adoption',
    'rich-only',
    'thinking-only',
  ] as const) {
    // Ordinary callback reads cannot adopt after the provider has ended; Live's exact Append can.
    if (carrier === 'ordinary' && ending === 'late-adoption') continue;
    test(`an adopted full-read Ask automatically receives the ${carrier} completed response: ${ending}`, async () => {
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
        let lateAdoption: (() => Promise<void>) | undefined;
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
                const adoptAsk = async () => {
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
                };
                if (ending === 'late-adoption') lateAdoption = adoptAsk;
                else await adoptAsk();
                if (ending === 'rich-only') {
                  yield {
                    type: 'system_info',
                    catId: 'codex',
                    content: JSON.stringify({
                      type: 'rich_block',
                      block: {
                        kind: 'card',
                        v: 1,
                        id: 'rich-answer',
                        title: 'Answer',
                        bodyMarkdown: 'canonical rich answer',
                      },
                    }),
                    timestamp: Date.now(),
                  };
                } else if (ending === 'thinking-only') {
                  yield {
                    type: 'system_info',
                    catId: 'codex',
                    content: JSON.stringify({ type: 'thinking', text: 'stored non-text output sentinel' }),
                    timestamp: Date.now(),
                  };
                } else {
                  yield {
                    type: 'text',
                    catId: 'codex',
                    content:
                      ending === 'mentioned-final'
                        ? '@dot\ncanonical answer to the adopted Ask'
                        : 'canonical answer to the adopted Ask, without a mention',
                    timestamp: Date.now(),
                  };
                }
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
          ...(ending === 'rich-only'
            ? { freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore: f.messages }) }
            : {}),
          dotReplyTarget: async (source: DotReplyCandidate) => {
            if (lateAdoption) {
              const adopt = lateAdoption;
              lateAdoption = undefined;
              await adopt();
            }
            return f.asks.replyTarget(source);
          },
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
        assert.ok(askId, JSON.stringify({ routeEvents, execution: child && turns.get(child.invocationId) }));
        assert.ok(child);
        const source = f.messages.getById(askId);
        const responseId = source?.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === 'codex')?.statusMessageId;
        assert.ok(responseId);
        const final = f.messages.getById(responseId);
        assert.ok(final);
        assert.equal(final.lifecycle?.kind, 'response');
        assert.equal(final.lifecycle?.status, 'completed');
        assert.ok(final.lifecycle?.inputMessageIds.includes(askId));
        assert.deepEqual(
          final.mentions,
          ['gpt-dot'],
          'adopted Ask must receive the canonical completed response automatically',
        );
        assert.equal(final.extra?.causal?.triggerMessageId, askId);
        assert.equal(final.replyTo, askId);
        assert.equal(final.extra?.turnExecution?.invocationId, child.invocationId);
        assert.equal(
          turns.get(child.invocationId)?.causal?.triggerMessageId,
          trigger.id,
          'execution origin stays immutable',
        );
        const returnEntries = f.queue.list(thread.id, 'owner').filter((entry) => entry.targets.includes('gpt-dot'));
        assert.equal(returnEntries.length, 1, 'an explicit mention and automatic return share one durable wake');
        assert.equal(returnEntries[0]?.payload.messageId, final.id);
        if (carrier === 'ordinary' && ending === 'provider-final') {
          // These are the fixture's private credentials and mocked webhook, never a real provider.
          const state = await f.connection.current();
          assert.ok(state?.subscription);
          const subscription = state.subscription;
          await f.connection.unsubscribe(f.setup.credentialSecret, subscription.url, state.attemptId);
          assert.equal((await f.deliver(final.id)).kind, 'fallback');
          assert.equal(f.events.length, 0, 'revocation after binding still blocks the completed response');
          const renew = (ttlMs: number | null) =>
            f.connection.subscribe(f.setup.credentialSecret, {
              attemptId: state.attemptId,
              pairingCode: f.setup.pairingCode!,
              url: subscription.url,
              secret: subscription.secret,
              ttlMs,
            });
          await renew(1);
          const expiresAt = (await f.connection.current())?.subscription?.expiresAt;
          assert.ok(expiresAt);
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt + 1 - Date.now())));
          assert.equal((await f.deliver(final.id)).kind, 'fallback');
          assert.equal(f.events.length, 0, 'expiry after binding still blocks the completed response');
          await renew(null);
        }
        assert.equal((await f.deliver(final.id)).kind, 'sent');
        assert.equal(f.events.length, 1);
        assert.equal(f.events[0]?.data.source_message_id, final.id);
        const read = await f.app.inject({
          method: 'POST',
          url: '/api/plugins/chatgpt-dot/mcp',
          headers: { authorization: `Bearer ${f.setup.credentialSecret}` },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'cat_cafe_dot_read_source', arguments: { event_id: f.events[0]!.eventId } },
          },
        });
        assert.equal(read.statusCode, 200, read.body);
        const result = read.json<{
          result: {
            isError: boolean;
            structuredContent: Awaited<ReturnType<typeof f.returns.read>>;
            content: Array<{ text: string }>;
          };
        }>().result;
        assert.equal(result?.isError, false, read.body);
        const projected = result.structuredContent.source;
        assert.equal(projected.id, final.id);
        assert.equal(projected.content, final.content, 'source text is preserved verbatim');
        assert.deepEqual(projected.contentBlocks, final.contentBlocks ?? []);
        if (ending === 'rich-only') {
          assert.ok(final.extra?.rich?.blocks.length, 'fixture must contain an actual stored rich answer');
          assert.deepEqual(projected.rich, final.extra.rich, 'dot must read the delivered rich answer');
        }
        if (ending === 'thinking-only') {
          assert.equal(final.thinking, 'stored non-text output sentinel');
          assert.equal(projected.thinking, final.thinking, 'stored non-text output stays a separate typed field');
        }
        assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent);
      } finally {
        await f.close();
      }
    });
  }
}
