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

const DELIVERY_DEPS = { delivery: { deliver: async () => ({ state: 'queued' }) } };

function build({ isKnownCat = () => true, deliverFn }) {
  return new LimbTranscriptCatDelivery({ isKnownCat, deliverFn, deliveryDeps: DELIVERY_DEPS });
}

test('admits the transcript once, through the atomic seam, for the bound cat only', async () => {
  const calls = [];
  const delivery = build({
    isKnownCat: (catId) => catId === 'codex-sol',
    deliverFn: async (deps, input) => {
      calls.push({ deps, input });
      return { messageId: 'message-1', content: input.content, admitted: true };
    },
  });

  assert.deepEqual(await delivery.deliverTranscript({ binding, observation }), {
    messageId: 'message-1',
  });

  // One admission. There is no separate append+trigger pair to fall out of step any more.
  assert.equal(calls.length, 1);
  const { deps, input } = calls[0];
  assert.equal(deps, DELIVERY_DEPS, 'the delivery port must be the injected one');
  assert.equal(input.idempotencyKey, 'limb:stackchan-home:observation-1');
  assert.equal(input.content, '大猫猫，你在吗？');
  assert.equal(input.catId, 'codex-sol');
  assert.equal(input.threadId, 'thread-stackchan');
  assert.equal(input.userId, 'default-user');
  assert.equal(input.source.connector, 'physical-limb.stackchan');
  assert.equal(input.source.meta.interactionId, 'interaction-1');
  assert.equal(input.source.meta.observationId, 'observation-1');
  // The device's capture instant survives the migration; admission time is not a substitute.
  assert.equal(input.timestamp, Date.parse('2026-08-01T09:15:00.000Z'));
});

test('refuses an unknown bound cat before admitting anything', async () => {
  let admissions = 0;
  const delivery = build({
    isKnownCat: () => false,
    deliverFn: async () => {
      admissions += 1;
      return { messageId: 'message-1', content: '', admitted: true };
    },
  });

  await assert.rejects(delivery.deliverTranscript({ binding, observation }), /unknown bound cat/);
  assert.equal(admissions, 0);
});

test('throws when the envelope did not reach the Queue, so the ingress claim is released', async () => {
  // LimbObservationRouter releases the observation claim only on a throw. Returning a messageId for
  // an envelope that was never admitted would mark the utterance handled while nothing will run it.
  const delivery = build({
    deliverFn: async () => ({ messageId: '', content: '', admitted: false }),
  });

  await assert.rejects(delivery.deliverTranscript({ binding, observation }), /not admitted to the queue/);
});

test('propagates queue back-pressure instead of reporting a delivered transcript', async () => {
  const delivery = build({
    deliverFn: async () => {
      throw Object.assign(new Error('Producer return queue is full'), { code: 'ROUTE_QUEUE_FULL' });
    },
  });

  await assert.rejects(delivery.deliverTranscript({ binding, observation }), (err) => {
    assert.equal(err.code, 'ROUTE_QUEUE_FULL');
    return true;
  });
});
