import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { exposeDotAskToLive } from './helpers/f247-dot-live-lifecycle.js';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const carrier of ['ordinary', 'live'] as const) {
  for (const scenario of ['full-read', 'unread', 'stale-child', 'stale-exposure', 'independent-post'] as const) {
    test(`an incoming dot Ask during another ${carrier} turn: ${scenario}`, async () => {
      const turns = new InMemoryTurnExecutionStore();
      const f = await dotProactiveFixture({ turnExecutionStore: turns });
      try {
        const thread = f.thread(scenario);
        const trigger = f.messages.append({
          userId: 'owner',
          threadId: thread.id,
          from: { kind: 'user', userId: 'owner' },
          content: 'deployment ready',
          mentions: [],
          timestamp: Date.now(),
        });
        const auth = await f.registry.create('owner', createCatId('codex'), thread.id, undefined, trigger.id);
        const startedAt = Date.now();
        turns.createRunning({
          invocationId: auth.invocationId,
          parentInvocationId: auth.invocationId,
          threadId: thread.id,
          userId: 'owner',
          catId: createCatId('codex'),
          executionKind: 'ordinary',
          startedAt: scenario === 'stale-exposure' ? startedAt + 60_000 : startedAt,
          ...(carrier === 'live' ? { queueCompletionPolicy: 'explicit_source' as const } : {}),
          causal: { triggerMessageId: trigger.id, coveredMessageIds: [trigger.id] },
        });
        const ask = await f.ask(thread.id, 'incoming-ask');
        const root = ask.result.structuredContent.messageId as string;
        if (scenario !== 'unread') {
          await exposeDotAskToLive(f, {
            threadId: thread.id,
            invocationId: scenario === 'stale-child' ? 'replacement-child' : auth.invocationId,
            messageId: root,
            startedAt,
          });
        }
        const response = await f.app.inject({
          method: 'POST',
          url: '/api/callbacks/post-message',
          headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
          payload: {
            content: 'Ask boot30 answer',
            replyTo: root,
            ...(scenario === 'independent-post' ? {} : { targetCats: ['gpt-dot'] }),
          },
        });
        assert.equal(response.statusCode, 200, response.payload);
        const answer = f.messages.getById(response.json().messageId);
        assert.ok(answer);
        assert.equal(answer.replyTo, root);
        if (scenario === 'full-read') {
          assert.deepEqual(answer.mentions, ['gpt-dot']);
          assert.equal(answer.extra?.causal?.triggerMessageId, root);
          assert.equal(answer.extra?.turnExecution?.invocationId, auth.invocationId);
          assert.equal((await f.deliver(answer.id)).kind, 'sent');
          assert.equal((await f.deliver(answer.id)).kind, 'sent');
          assert.equal(f.events.length, 1, 'the same callback delivery is idempotent');
          assert.equal(f.events[0]?.data.source_message_id, answer.id);
        } else {
          assert.equal(answer.extra?.causal?.triggerMessageId, trigger.id);
          if (scenario === 'independent-post') assert.deepEqual(answer.mentions, []);
          else {
            assert.notEqual((await f.deliver(answer.id)).kind, 'sent');
            assert.equal(f.events.length, 0, 'unread or differently owned input cannot grant a cloud return');
          }
        }
        assert.equal(turns.get(auth.invocationId)?.causal?.triggerMessageId, trigger.id);
      } finally {
        await f.close();
      }
    });
  }
}
