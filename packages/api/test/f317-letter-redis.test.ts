import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { companionTextDigest } from '../src/domains/cats/services/stores/companion-submission-state.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import { MessageKeys } from '../src/domains/cats/services/stores/redis-keys/message-keys.js';
import { CompanionSubmissionDelivery } from '../src/domains/concierge/live/host/companion-submission-delivery.js';
import { REDIS_SKIP, withRedisStore } from './helpers/f317-ns-reg-redis.js';

test(
  'Redis rebuild recovers the original accepted send and keeps newer draft text with no expiry',
  { skip: REDIS_SKIP },
  async () =>
    withRedisStore(async (store, redis) => {
      const clientMessageId = randomUUID();
      const submission = {
        clientMessageId,
        text: 'Input A',
        callId: null,
        submissionRevision: 1,
        reservationRevision: 2,
        createdAt: 100,
      };
      await store.putOwnerComposerDraft('owner', 'home', {
        expectedRevision: 0,
        text: 'Newer draft B',
        updatedAt: 101,
        companionSubmissions: [submission],
      });
      const original = (
        await store.appendIdempotent({
          userId: 'owner',
          threadId: 'home',
          from: { kind: 'user', userId: 'owner' },
          content: submission.text,
          mentions: [],
          timestamp: 100,
          idempotencyKey: clientMessageId,
        })
      ).message;
      const fact = {
        ownerUserId: 'owner',
        threadId: 'home',
        clientMessageId,
        callId: null,
        contentDigest: companionTextDigest(submission.text),
        acceptedAt: 102,
      };
      assert.equal(
        await store.recordCompanionDeliveryAcceptance(original.id, { ...fact, ownerUserId: 'foreign' }),
        null,
      );
      assert.equal(
        await store.recordCompanionDeliveryAcceptance(original.id, { ...fact, contentDigest: 'a'.repeat(64) }),
        null,
      );
      assert.equal((await store.recordCompanionDeliveryAcceptance(original.id, fact))?.id, original.id);
      const rebuilt = new RedisMessageStore(redis);
      let requests = 0;
      const manager = new CompanionSubmissionDelivery({
        ownerUserId: 'owner',
        messages: rebuilt,
        client: {
          async request() {
            requests++;
            return {};
          },
        },
        conversationThread: async () => 'home',
        currentCallId: () => randomUUID(),
        assertCurrent: async () => {},
      });
      const recovered = await manager.readDraft();
      assert.equal(recovered.status, 'available');
      if (recovered.status !== 'available') return;
      assert.equal(recovered.text, 'Newer draft B');
      assert.equal(recovered.submissions[0]?.receipt.delivery, 'accepted');
      assert.equal(
        (
          await manager.submit({
            scopeRef: recovered.scopeRef,
            text: submission.text,
            clientMessageId,
            submissionRevision: 1,
          })
        ).delivery,
        'accepted',
      );
      assert.equal(requests, 0, 'reconcile uses the original durable acceptance, never a new transport');
      assert.equal(await redis.ttl(MessageKeys.ownerComposerDraft('owner', 'home')), -1);
      assert.equal(await redis.ttl(MessageKeys.detail(original.id)), -1);
      await rebuilt.clearOwnerComposerDraft('owner', 'home', recovered.revision, 103);
      assert.deepEqual(
        (await new RedisMessageStore(redis).getOwnerComposerDraft('owner', 'home'))?.companionSubmissions,
        [submission],
      );
    }),
);

test(
  'Redis recall removes the protected receipt while preserving unresolved draft recovery',
  { skip: REDIS_SKIP },
  async () =>
    withRedisStore(async (store, redis) => {
      const clientMessageId = randomUUID();
      const original = (
        await store.appendIdempotent({
          userId: 'owner',
          threadId: 'home',
          from: { kind: 'user', userId: 'owner' },
          content: 'Queued input',
          mentions: [],
          timestamp: 100,
          idempotencyKey: clientMessageId,
          deliveryStatus: 'queued',
        })
      ).message;
      assert.ok(
        await store.recordCompanionDeliveryAcceptance(original.id, {
          ownerUserId: 'owner',
          threadId: 'home',
          clientMessageId,
          callId: null,
          contentDigest: companionTextDigest(original.content),
          acceptedAt: 101,
        }),
      );
      const pending = {
        clientMessageId: randomUUID(),
        text: 'Unconfirmed input',
        callId: null,
        submissionRevision: 0,
        reservationRevision: 1,
        createdAt: 99,
      };
      await store.putOwnerComposerDraft('owner', 'home', {
        expectedRevision: 0,
        text: '',
        updatedAt: 101,
        companionSubmissions: [pending],
      });
      const result = await store.recallMessageToComposerDraft(original.id, {
        ownerUserId: 'owner',
        threadId: 'home',
        expectedDraftRevision: 1,
        merge: 'replace',
        recalledAt: 102,
      });
      assert.equal(result.kind, 'recalled');
      assert.equal(await redis.hexists(MessageKeys.detail(original.id), 'companionDeliveryReceipt'), 0);
      const rebuilt = new RedisMessageStore(redis);
      assert.equal((await rebuilt.getById(original.id))?.companionDeliveryReceipt, undefined);
      assert.deepEqual((await rebuilt.getOwnerComposerDraft('owner', 'home'))?.companionSubmissions, [pending]);
    }),
);
