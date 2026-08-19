import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

import {
  MemoryLimbEmbodimentBindingStore,
  RedisLimbEmbodimentBindingStore,
} from '../dist/domains/limb/LimbEmbodimentBindingStore.js';
import { MemoryLimbObservationReceiptStore } from '../dist/domains/limb/LimbObservationRouter.js';
import { registerLimbObservationRoutes } from '../dist/routes/limb-observation-routes.js';

const NOW = Date.parse('2026-08-01T09:15:00.000Z');

function transcript(overrides = {}) {
  return {
    v: 1,
    observationId: 'observation-transcript-1',
    nodeId: 'stackchan-home',
    occurredAt: new Date(NOW - 500).toISOString(),
    sessionId: 'session-1',
    kind: 'transcript',
    payload: {
      interactionId: 'interaction-1',
      text: '大猫猫，你在吗？',
      language: 'zh',
      captureDurationMs: 5_000,
    },
    ...overrides,
  };
}

function touch(overrides = {}) {
  return {
    v: 1,
    observationId: 'observation-touch-1',
    nodeId: 'stackchan-home',
    occurredAt: new Date(NOW - 5_500).toISOString(),
    sessionId: 'session-1',
    kind: 'touch',
    payload: { gesture: 'stroke', durationMs: 780, confidence: 1 },
    ...overrides,
  };
}

async function createFixture({ capabilities, withBinding = true } = {}) {
  const app = Fastify();
  const bindingStore = new MemoryLimbEmbodimentBindingStore();
  if (withBinding) {
    await bindingStore.put({
      nodeId: 'stackchan-home',
      userId: 'default-user',
      threadId: 'thread-stackchan',
      catId: 'codex-sol',
      expressionRef: 'yanyan:replying',
      voiceProfileRef: 'yanyan:local',
      volumePercent: 35,
      updatedAt: NOW,
    });
  }
  const delivered = [];
  registerLimbObservationRoutes(app, {
    pairingStore: {
      findByApiKey(apiKey) {
        if (apiKey !== 'approved-key') return undefined;
        return {
          nodeId: 'stackchan-home',
          capabilities: capabilities ?? [
            { cap: 'limb.observe.touch', commands: [], authLevel: 'free' },
            { cap: 'limb.sensor.microphone', commands: [], authLevel: 'gated' },
          ],
        };
      },
    },
    limbRegistry: {
      getNode(nodeId) {
        return nodeId === 'stackchan-home' ? { status: 'online' } : undefined;
      },
    },
    bindingStore,
    receiptStore: new MemoryLimbObservationReceiptStore(),
    now: () => NOW,
    delivery: {
      async deliverTranscript(input) {
        delivered.push(input);
        return { messageId: 'message-1' };
      },
    },
  });
  await app.ready();
  return { app, delivered };
}

describe('limb observation ingress', () => {
  it('records a typed touch as reflex-only and invokes exactly the bound cat for transcript', async () => {
    const { app, delivered } = await createFixture();
    const headers = { authorization: 'Bearer approved-key' };

    const touchResponse = await app.inject({
      method: 'POST',
      url: '/api/limb/observations',
      headers,
      payload: { observation: touch() },
    });
    assert.equal(touchResponse.statusCode, 202);
    assert.deepEqual(touchResponse.json(), { status: 'reflex_only' });
    assert.equal(delivered.length, 0);

    const transcriptResponse = await app.inject({
      method: 'POST',
      url: '/api/limb/observations',
      headers,
      payload: { observation: transcript() },
    });
    assert.equal(transcriptResponse.statusCode, 202);
    assert.deepEqual(transcriptResponse.json(), { status: 'routed', messageId: 'message-1' });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].binding.catId, 'codex-sol');
    assert.equal(delivered[0].binding.threadId, 'thread-stackchan');
    assert.equal(delivered[0].observation.payload.text, '大猫猫，你在吗？');
  });

  it('deduplicates a delivered transcript before a second cat invocation', async () => {
    const { app, delivered } = await createFixture();
    const request = {
      method: 'POST',
      url: '/api/limb/observations',
      headers: { authorization: 'Bearer approved-key' },
      payload: { observation: transcript() },
    };

    assert.equal((await app.inject(request)).statusCode, 202);
    const duplicate = await app.inject(request);
    assert.equal(duplicate.statusCode, 200);
    assert.deepEqual(duplicate.json(), { status: 'duplicate' });
    assert.equal(delivered.length, 1);
  });

  it('rejects unapproved keys, node mismatch, missing grants, stale input, and unbound nodes', async () => {
    const authorized = { authorization: 'Bearer approved-key' };
    const fixture = await createFixture();
    assert.equal(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/limb/observations',
          headers: { authorization: 'Bearer wrong' },
          payload: { observation: transcript() },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/limb/observations',
          headers: authorized,
          payload: { observation: transcript({ nodeId: 'other-body' }) },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await fixture.app.inject({
          method: 'POST',
          url: '/api/limb/observations',
          headers: authorized,
          payload: {
            observation: transcript({ occurredAt: new Date(NOW - 61_000).toISOString() }),
          },
        })
      ).statusCode,
      409,
    );

    const noGrant = await createFixture({ capabilities: [] });
    assert.equal(
      (
        await noGrant.app.inject({
          method: 'POST',
          url: '/api/limb/observations',
          headers: authorized,
          payload: { observation: transcript() },
        })
      ).statusCode,
      403,
    );

    const unbound = await createFixture({ withBinding: false });
    assert.equal(
      (
        await unbound.app.inject({
          method: 'POST',
          url: '/api/limb/observations',
          headers: authorized,
          payload: { observation: transcript() },
        })
      ).statusCode,
      409,
    );
  });

  it('strictly rejects raw media fields and unknown envelope members', async () => {
    const { app, delivered } = await createFixture();
    const response = await app.inject({
      method: 'POST',
      url: '/api/limb/observations',
      headers: { authorization: 'Bearer approved-key' },
      payload: {
        observation: {
          ...transcript(),
          raw_audio: 'forbidden',
        },
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(delivered.length, 0);
  });
});

describe('RedisLimbEmbodimentBindingStore', () => {
  it('persists active user-visible binding state without a TTL', async () => {
    const calls = [];
    const redis = {
      async set(...args) {
        calls.push(args);
        return 'OK';
      },
      async get() {
        return null;
      },
      async del() {
        return 1;
      },
      async sadd() {
        return 1;
      },
      async srem() {
        return 1;
      },
      async smembers() {
        return [];
      },
    };
    const store = new RedisLimbEmbodimentBindingStore(redis);
    await store.put({
      nodeId: 'stackchan-home',
      userId: 'default-user',
      threadId: 'thread-stackchan',
      catId: 'codex-sol',
      expressionRef: 'yanyan:replying',
      voiceProfileRef: 'yanyan:local',
      volumePercent: 35,
      updatedAt: NOW,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 2);
    assert.equal(calls[0][0], 'limb:embodiment-binding:stackchan-home');
  });
});
