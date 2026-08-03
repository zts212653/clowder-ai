import assert from 'node:assert/strict';
import test from 'node:test';

import { LimbTranscriptCatDelivery } from '../dist/domains/limb/LimbTranscriptCatDelivery.js';

const binding = {
  nodeId: 'stackchan-home',
  userId: 'default-user',
  threadId: 'thread-stackchan',
  catId: 'codex-sol',
  expressionRef: 'yanyan:replying',
  voiceProfileRef: 'yanyan:local',
  volumePercent: 35,
  updatedAt: Date.parse('2026-08-01T09:10:00.000Z'),
};
const observation = {
  v: 1,
  observationId: 'observation-1',
  nodeId: 'stackchan-home',
  occurredAt: '2026-08-01T09:15:00.000Z',
  sessionId: 'session-1',
  kind: 'transcript',
  payload: {
    interactionId: 'interaction-1',
    text: '大猫猫，你在吗？',
    language: 'zh',
    captureDurationMs: 5_000,
  },
};

test('appends transcript idempotently and invokes only the bound cat', async () => {
  const appended = [];
  const triggered = [];
  const delivery = new LimbTranscriptCatDelivery({
    isKnownCat: (catId) => catId === 'codex-sol',
    messageStore: {
      async append(input) {
        appended.push(input);
        return { id: 'message-1' };
      },
    },
    invokeTriggerProvider: {
      get() {
        return {
          async trigger(...args) {
            triggered.push(args);
            return 'dispatched';
          },
        };
      },
    },
  });

  assert.deepEqual(await delivery.deliverTranscript({ binding, observation }), {
    messageId: 'message-1',
  });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].idempotencyKey, 'limb:stackchan-home:observation-1');
  assert.equal(appended[0].content, '大猫猫，你在吗？');
  assert.deepEqual(appended[0].mentions, ['codex-sol']);
  assert.equal(appended[0].source.meta.interactionId, 'interaction-1');
  assert.deepEqual(triggered, [['thread-stackchan', 'codex-sol', 'default-user', '大猫猫，你在吗？', 'message-1']]);
});

test('fails before persistence when binding cat or invocation runtime is unavailable', async () => {
  let appendCount = 0;
  const base = {
    messageStore: {
      async append() {
        appendCount += 1;
        return { id: 'message-1' };
      },
    },
  };
  const unknownCat = new LimbTranscriptCatDelivery({
    ...base,
    isKnownCat: () => false,
    invokeTriggerProvider: { get: () => ({ trigger: async () => 'dispatched' }) },
  });
  await assert.rejects(unknownCat.deliverTranscript({ binding, observation }), /unknown bound cat/);

  const noRuntime = new LimbTranscriptCatDelivery({
    ...base,
    isKnownCat: () => true,
    invokeTriggerProvider: { get: () => undefined },
  });
  await assert.rejects(noRuntime.deliverTranscript({ binding, observation }), /invocation runtime is not ready/);
  assert.equal(appendCount, 0);
});
