import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { fixture, human } from './helpers/message-search-answer-fixture.js';

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  for (const outcome of ['completed', 'failed', 'no-text']) {
    test(`${name} ${outcome}: original final R owns its one answer card and failed output cannot publish it`, async () => {
      const f = fixture();
      try {
        const producer = { kind: 'invocation', id: `answer-${name}-${outcome}`, catId: 'opus' };
        let prepared;
        const services = {
          opus: {
            supportsToolExecutionPolicy: () => true,
            async *invoke() {
              prepared = await f.service.prepare({ ...f.request, producer });
              if (outcome === 'failed')
                yield { type: 'error', catId: 'opus', error: 'isolated provider failure', timestamp: Date.now() };
              else if (outcome !== 'no-text')
                yield { type: 'text', catId: 'opus', content: 'A real final answer.', timestamp: Date.now() };
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
          },
        };
        const deps = {
          services,
          messageStore: f.messages,
          messageSearchAnswerService: f.service,
          invocationDeps: {
            registry: {
              create: () => ({ invocationId: producer.id, callbackToken: String(Date.now()) }),
              verify: () => ({ ok: false, reason: 'unknown_invocation' }),
            },
            sessionManager: {
              get: async () => null,
              getOrCreate: async () => ({}),
              resolveWorkingDirectory: () => '/tmp/test',
            },
            threadStore: null,
            apiUrl: 'http://127.0.0.1:49153',
          },
          socketManager: { broadcastToRoom() {} },
        };
        const events = [];
        for await (const event of route(deps, ['opus'], 'Explain the decision.', 'owner', 'origin', {
          onLifecycleInvocationStarted: async (input) => {
            const message = await f.messages.append({
              from: { kind: 'agent', catId: input.catId },
              userId: input.userId,
              threadId: input.threadId,
              content: '',
              mentions: [],
              origin: 'stream',
              timestamp: input.startedAt,
              idempotencyKey: `message-lifecycle-response:${input.invocationId}`,
              lifecycle: {
                kind: 'response',
                orderKey: `${input.startedAt}:${input.invocationId}`,
                invocationId: input.invocationId,
                targetId: input.catId,
                inputEntryIds: ['entry'],
                inputMessageIds: [],
                status: 'processing',
                startedAt: input.startedAt,
              },
            });
            return { responseMessageId: message.id, priorFrontierMessageId: null };
          },
        }))
          events.push(event);
        assert.equal(f.searches(), 1, JSON.stringify(events.filter((event) => event.type === 'error')));
        assert.equal(f.calls(), 0);
        const messages = (await f.messages.getByThread('origin')).filter((message) => message.from?.kind === 'agent');
        const bound = messages.filter((message) => message.extra?.messageSearchAnswer);
        assert.equal(bound.length, outcome === 'failed' ? 0 : 1, JSON.stringify(messages));
        if (bound.length) {
          const message = bound[0];
          assert.equal(message.extra.messageSearchAnswer.publicationRef, prepared.publicationRef);
          assert.equal(message.lifecycle.status, 'completed');
          assert.equal(
            (await f.service.read(message.id, message.extra.messageSearchAnswer.blockId, human)).status,
            'available',
          );
          assert.ok(events.some((event) => event.type === 'done'));
          await f.service.recoverPreparedResponses();
          assert.equal(f.messages.getById(message.id).extra.rich.blocks.length, 1);
        }
      } finally {
        f.db.close();
      }
    });
  }
}
