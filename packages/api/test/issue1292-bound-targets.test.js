import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { privateInput, successorFixture } from './helpers/successor-routing-fixture.js';

for (const kind of ['conversation_input', 'private_input', 'message_wake']) {
  for (const healthy of ['codex', 'opus-5']) {
    test(
      `${kind}: a disabled bound target cannot cancel or duplicate healthy ${healthy}`,
      { timeout: 15000 },
      async (t) => {
        const h = successorFixture(t, { opus: { available: true } });
        const targetCats = ['opus', healthy];
        let admitted;
        if (kind === 'conversation_input') {
          const from = { kind: 'user', userId: 'owner' };
          admitted = await h.queue.send(
            h.messages,
            {
              from,
              userId: 'owner',
              threadId: h.threadId,
              content: 'work',
              mentions: targetCats,
              timestamp: 1,
              deliveryStatus: 'queued',
            },
            { ...privateInput(h.threadId), kind, from, targetCats },
          );
        } else {
          const input = privateInput(h.threadId, { kind, targetCats });
          if (kind === 'message_wake') {
            input.from = { kind: 'agent', catId: 'opus-5' };
            const source = await h.messages.append({
              from: input.from,
              userId: 'owner',
              threadId: h.threadId,
              content: 'work',
              mentions: targetCats,
              timestamp: 1,
            });
            input.messageId = source.id;
          }
          admitted = await h.queue.enqueueDurable(input);
        }
        getRoster().opus = {
          ...getRoster().opus,
          available: false,
          successor: healthy === 'opus-5' ? healthy : undefined,
        };
        assert.deepEqual(await h.router.resolveExplicitTargets(targetCats, h.threadId, { bound: true }), [healthy]);
        const completed = new Promise((resolve) =>
          h.processor.registerEntryCompleteHook(admitted.entry.id, (_id, status) => resolve(status), healthy),
        );
        await h.processor.requestDrain(h.threadId);
        assert.equal(await completed, 'succeeded');
        await h.processor.requestDrain(h.threadId);
        const deadline = Date.now() + 5000;
        while ((await h.ledger.list(h.threadId)).length && Date.now() < deadline) await delay(5);
        assert.deepEqual(await h.ledger.list(h.threadId), []);
        assert.deepEqual(h.calls, [healthy]);
      },
    );
  }
}
