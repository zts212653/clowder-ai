import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { FreshnessOutputCommitCoordinator } from '../src/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import type { AgentMessage, AgentService } from '../src/domains/cats/services/types.js';
import { dotLiveQueueProcessor } from './helpers/f247-dot-live-lifecycle.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const { dispatch, recipients } of [
  { dispatch: 'parallel', recipients: 'first' },
  { dispatch: 'parallel', recipients: 'second' },
  { dispatch: 'serial', recipients: 'first' },
] as const) {
  for (const output of ['text', 'rich', 'thinking', 'failed'] as const) {
    test(`Queue through AgentRouter returns exact adopted Ask responses: ${dispatch}/${recipients}/${output}`, async () => {
      const turns = new InMemoryTurnExecutionStore();
      const f = await dotProactiveFixture({ turnExecutionStore: turns, messageDisposition: 'continue_current' });
      try {
        if (!catRegistry.has('codex-peer'))
          catRegistry.register('codex-peer', {
            ...catRegistry.getOrThrow('codex').config,
            id: createCatId('codex-peer'),
            displayName: 'fixture Codex peer',
            mentionPatterns: ['@codex-peer'],
          });
        const thread = f.thread('parallel adopted Ask');
        const cats = (dispatch === 'parallel' ? ['codex', 'codex-peer'] : ['codex']).map(createCatId);
        f.threads.addParticipants(thread.id, cats);
        const recipient = recipients === 'second' ? cats[1] : cats[0];
        assert.ok(recipient);
        const targets = [recipient];
        const from = { kind: 'user' as const, userId: 'owner' };
        const admitted = await f.queue.send(
          f.messages,
          {
            from,
            userId: 'owner',
            threadId: thread.id,
            content: 'original multi-cat input',
            mentions: cats,
            timestamp: Date.now(),
            deliveryStatus: 'queued',
          },
          {
            from,
            userId: 'owner',
            threadId: thread.id,
            content: 'original multi-cat input',
            kind: 'conversation_input',
            ownerAuthProvenance: 'strict',
            targetCats: cats,
            intent: 'execute',
          },
        );
        assert.equal(admitted.outcome, 'enqueued');
        assert.ok(admitted.outcome === 'enqueued' && admitted.entry);
        const children = new Map<string, Awaited<ReturnType<typeof f.registry.create>>>();
        const create = f.registry.create.bind(f.registry);
        f.registry.create = async (...args) => {
          const child = await create(...args);
          children.set(String(args[1]), child);
          return child;
        };
        let releaseStarted!: () => void;
        const bothStarted = new Promise<void>((resolve) => {
          releaseStarted = resolve;
        });
        let started = 0;
        let askId: string | undefined;
        const ask = bothStarted.then(async () => {
          const result = await f.rpc({
            attempt_id: f.setup.attemptId,
            thread_id: thread.id,
            target_cat_ids: targets,
            content: 'incoming consultation while both cats run',
            client_message_id: 'parallel-ask',
          });
          askId = result.result?.structuredContent?.messageId;
          assert.ok(askId, JSON.stringify(result));
          return askId;
        });
        let releaseRead!: () => void;
        let readers = 0;
        const allRead = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        const services = new AgentRegistry();
        for (const catId of cats) {
          const service: AgentService = {
            supportsToolExecutionPolicy: () => true,
            async *invoke(): AsyncGenerator<AgentMessage> {
              started += 1;
              if (started === cats.length) releaseStarted();
              const root = await ask;
              const child = children.get(catId);
              assert.ok(child);
              if (targets.includes(catId)) {
                const read = await f.app.inject({
                  method: 'GET',
                  url: `/api/callbacks/thread-context?messageId=${root}&before=0&after=0&responseMode=full`,
                  headers: { 'x-invocation-id': child.invocationId, 'x-callback-token': child.callbackToken },
                });
                assert.equal(read.statusCode, 200, read.body);
                assert.ok(
                  read.json().messages.some((message: { id: string }) => message.id === root),
                  read.body,
                );
                assert.ok(f.messages.getById(root)?.lifecycle?.dispatchRefs?.some((ref) => ref.targetId === catId));
                readers += 1;
                if (readers === targets.length) releaseRead();
              }
              await allRead;
              if (output === 'text')
                yield { type: 'text', catId, content: `answer from ${catId}`, timestamp: Date.now() };
              else if (output === 'failed')
                yield { type: 'error', catId, error: 'fixture provider failure', timestamp: Date.now() };
              else
                yield {
                  type: 'system_info',
                  catId,
                  timestamp: Date.now(),
                  content: JSON.stringify(
                    output === 'rich'
                      ? {
                          type: 'rich_block',
                          block: { kind: 'card', v: 1, id: 'answer', title: catId, bodyMarkdown: 'actual rich answer' },
                        }
                      : { type: 'thinking', text: 'stored presentation sentinel' },
                  ),
                };
              yield { type: 'done', catId, timestamp: Date.now() };
            },
          };
          services.register(catId, service);
        }
        const router = new AgentRouter({
          agentRegistry: services,
          registry: f.registry,
          messageStore: f.messages,
          threadStore: f.threads,
          turnExecutionStore: turns,
          socketManager: f.socket,
          dotReplyTarget: (source) => f.asks.replyTarget(source),
          freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore: f.messages }),
        });
        const route = router.routeExecution.bind(router);
        let parallelCalls = 0;
        router.routeExecution = async function* (...args) {
          assert.equal(
            args[6].targetDispatchMode,
            dispatch,
            'real Queue must select by admitted fan-out, despite execute intent',
          );
          assert.equal(args[4].length, cats.length);
          parallelCalls += 1;
          yield* route(...args);
        };
        const { processor, tracker } = dotLiveQueueProcessor(f, router, turns);
        tracker.start(thread.id, 'gpt-dot', 'owner', ['gpt-dot'], 'cloud-delivery-fixture');
        const finished = Promise.all(
          cats.map(
            (catId) =>
              new Promise<void>((resolve) => {
                processor.registerEntryCompleteHook(admitted.entry!.id, () => resolve(), catId);
              }),
          ),
        );
        assert.equal((await processor.processNext(thread.id, 'owner')).started, true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            finished,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('parallel Queue did not finish')), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          tracker.complete(thread.id, 'gpt-dot');
        }
        assert.equal(parallelCalls, 1);
        assert.equal(children.size, cats.length);
        await ask;
        assert.ok(askId);
        let expectedReturns = 0;
        for (const catId of cats) {
          const child = children.get(catId)!;
          const final = (await f.messages.getByThread(thread.id)).find(
            (message) =>
              message.lifecycle?.kind === 'response' && message.lifecycle.invocationId === child.invocationId,
          );
          assert.ok(final);
          assert.equal(turns.get(child.invocationId)?.causal?.triggerMessageId, admitted.message.id);
          const shouldReturn = targets.includes(catId) && output !== 'failed';
          assert.deepEqual(
            final.mentions,
            shouldReturn ? ['gpt-dot'] : [],
            JSON.stringify({ catId, source: f.messages.getById(askId), final }),
          );
          assert.equal(final.lifecycle?.status, output === 'failed' ? 'failed' : 'completed');
          if (!shouldReturn) {
            if (output === 'failed') assert.notEqual(final.extra?.causal?.triggerMessageId, askId);
            else assert.equal(final.extra?.causal?.triggerMessageId, admitted.message.id);
            continue;
          }
          expectedReturns += 1;
          assert.equal(final.replyTo, askId);
          assert.equal(final.extra?.causal?.triggerMessageId, askId);
          assert.ok(final.lifecycle?.inputMessageIds.includes(askId));
          const entries = f.queue
            .list(thread.id, 'owner')
            .filter((entry) => entry.payload.messageId === final.id && entry.targets.includes('gpt-dot'));
          assert.equal(entries.length, 1);
          assert.equal((await f.deliver(final.id)).kind, 'sent');
          const event = f.events.at(-1)!;
          const read = await f.returns.read(f.setup.credentialSecret, event.eventId);
          assert.equal(read.source.id, final.id);
          assert.equal(read.source.content, final.content);
          if (output === 'rich') assert.deepEqual(read.source.rich, final.extra?.rich);
          if (output === 'thinking') assert.equal(read.source.thinking, final.thinking);
        }
        assert.equal(f.events.length, expectedReturns);
        assert.equal(
          f.queue.list(thread.id, 'owner').filter((entry) => entry.targets.includes('gpt-dot')).length,
          expectedReturns,
        );
      } finally {
        await f.close();
      }
    });
  }
}
