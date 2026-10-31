import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { EventMemoryStore, eventMemoryRevision } from '../dist/domains/memory/EventMemoryStore.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../dist/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import { callbackProposeEventMemoryCorrectionRoutes } from '../dist/routes/callback-propose-event-memory-correction-routes.js';

const ownerUserId = 'event-proposal-owner';
const threadId = 'thread-proposal-origin';
const messageId = 'message-proposal-origin';

describe('F321 callback Event correction proposal', () => {
  let app;
  let eventStore;
  let proposalStore;
  let event;
  let published;

  beforeEach(async () => {
    eventStore = new EventMemoryStore(':memory:');
    await eventStore.initialize();
    event = eventStore.markEvent(
      {
        type: 'scope_correction',
        trigger: 'human_brake',
        cat: 'codex-sol',
        threadId,
        messageId,
        timestamp: 100,
        summary: 'Over-broad current summary.',
        cognitiveTransition: 'scope_correction',
        relatedHarness: ['F321'],
        confidence: 'high',
      },
      ownerUserId,
    ).event;
    proposalStore = new InMemoryEventMemoryCorrectionProposalStore();
    published = [];
    app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'invocation-proposal',
        callbackToken: 'callback-token',
        catId: 'codex-sol',
        threadId: 'thread-where-used',
        userId: ownerUserId,
        originTriggerMessageId: 'message-where-used',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      done();
    });
    await app.register(callbackProposeEventMemoryCorrectionRoutes, {
      registry: { isLatest: async () => true },
      eventMemoryStore: eventStore,
      proposalStore,
      sourceReaders: {
        threadStore: {
          get: async (id) =>
            id === threadId ? { id, title: 'Original thread', createdBy: ownerUserId, visibility: 'private' } : null,
          list: async () => [],
        },
        messageStore: {
          getById: async (id) =>
            id === messageId
              ? {
                  id,
                  threadId,
                  userId: ownerUserId,
                  catId: null,
                  content: 'Original source text.',
                  timestamp: 90,
                  deliveryStatus: 'delivered',
                }
              : null,
        },
      },
      approvalIngress: { publish: async (draft) => published.push(draft) },
    });
    await app.ready();
  });

  afterEach(async () => app.close());

  it('server-binds owner, proposal origin, and original Event source while deduplicating retries', async () => {
    const payload = {
      eventId: event.eventId,
      expectedRevision: eventMemoryRevision(event),
      reason: 'unsupported_by_source',
      suggestedPatch: { summary: 'A narrower source-supported summary.' },
      clientRequestId: 'event-correction:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-event-memory-correction',
      payload,
    });
    assert.equal(first.statusCode, 200, first.body);
    const proposal = await proposalStore.get(first.json().proposalId);
    assert.equal(proposal.ownerUserId, ownerUserId);
    assert.equal(proposal.sourceCatId, 'codex-sol');
    assert.equal(proposal.sourceThreadId, 'thread-where-used');
    assert.deepEqual(proposal.source, { threadId, messageId });
    assert.deepEqual(proposal.approvalOriginRef, {
      kind: 'message',
      threadId: 'thread-where-used',
      messageId: 'message-where-used',
    });
    assert.equal(published[0].producerId, 'F321');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-event-memory-correction',
      payload,
    });
    assert.equal(replay.json().proposalId, proposal.proposalId);
    assert.equal(replay.json().recovered, true);
  });

  it('rejects stale revisions and caller-supplied source coordinates', async () => {
    const base = {
      eventId: event.eventId,
      expectedRevision: eventMemoryRevision(event),
      reason: 'outdated',
      suggestedPatch: { summary: 'Later context.' },
      clientRequestId: 'event-correction:118f2d5e-9f45-7d8c-a829-88f6440a4f15',
    };
    const spoofed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-event-memory-correction',
      payload: { ...base, threadId: 'spoofed', messageId: 'spoofed' },
    });
    assert.equal(spoofed.statusCode, 400);
    const stale = await app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-event-memory-correction',
      payload: { ...base, expectedRevision: `sha256:${'f'.repeat(64)}` },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().code, 'stale_revision');
  });
});
