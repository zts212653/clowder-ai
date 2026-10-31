import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { SessionMutex } from '../dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { EventMemoryStore } from '../dist/domains/memory/EventMemoryStore.js';
import { EventMemoryLifecycleService } from '../dist/domains/memory/event/EventMemoryLifecycleService.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../dist/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { sessionAuthPlugin, sessionRoute } from '../dist/infrastructure/session-auth.js';
import { registerEventMemoryCorrectionDecisionRoutes } from '../dist/routes/event-memory-correction-decision-routes.js';
import { eventsRoutes } from '../dist/routes/events.js';

const ownerUserId = 'event-owner';
const origin = 'http://localhost:3003';

function record(overrides = {}) {
  return {
    type: 'scope_correction',
    trigger: 'human_brake',
    cat: 'codex-sol',
    threadId: 'thread-event-source',
    messageId: 'message-event-source',
    timestamp: 100,
    summary: 'The original event summary.',
    cognitiveTransition: 'scope_correction',
    relatedHarness: ['F321'],
    confidence: 'high',
    ...overrides,
  };
}

function cookieHeader(response) {
  const raw = response.headers['set-cookie'];
  assert.ok(raw);
  return raw.split(';', 1)[0];
}

describe('F321 Event owner lifecycle', () => {
  let app;
  let store;
  let proposalStore;
  let session;

  beforeEach(async () => {
    store = new EventMemoryStore(':memory:');
    await store.initialize();
    proposalStore = new InMemoryEventMemoryCorrectionProposalStore();
    const coordinator = new OwnerMemoryActionCoordinator({
      store: new InMemoryOwnerMemoryActionReceiptStore(),
      lock: new SessionMutex(),
    });
    const lifecycle = new EventMemoryLifecycleService({
      store,
      coordinator,
      sourceAvailable: async () => true,
    });
    app = Fastify();
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId });
    await app.register(eventsRoutes, {
      eventMemoryStore: store,
      lifecycleService: lifecycle,
      correctionProposalStore: proposalStore,
      threadStore: {
        get: async (id) =>
          id === 'thread-event-source'
            ? { id, title: 'Event source', createdBy: ownerUserId, visibility: 'private' }
            : null,
        list: async () => [],
      },
      messageStore: {
        getById: async (id) =>
          id === 'message-event-source'
            ? {
                id,
                threadId: 'thread-event-source',
                userId: ownerUserId,
                catId: null,
                content: 'Source text stays in the original conversation.',
                timestamp: 90,
                deliveryStatus: 'delivered',
              }
            : null,
      },
    });
    registerEventMemoryCorrectionDecisionRoutes(app, {
      store: proposalStore,
      lifecycle,
      socketManager: { emitToUser: () => {} },
    });
    await app.ready();
    const login = await app.inject({ method: 'GET', url: '/api/session', headers: { origin } });
    session = { cookie: cookieHeader(login), csrf: login.json().csrfToken };
  });

  afterEach(async () => app.close());

  function ownerHeaders() {
    return { cookie: session.cookie, origin, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  }

  async function postAction(eventId, payload) {
    return app.inject({
      method: 'POST',
      url: `/api/memory/events/${eventId}/actions`,
      headers: ownerHeaders(),
      payload,
    });
  }

  it('projects revisions, revalidates source, and applies correction/retire/forget idempotently', async () => {
    const eventId = store.markEvent(record(), ownerUserId).event.eventId;
    const list = await app.inject({ method: 'GET', url: '/api/memory/events', headers: { cookie: session.cookie } });
    assert.equal(list.statusCode, 200);
    const initial = list.json().events[0];
    assert.equal(initial.status, 'active');
    assert.equal(initial.pendingCorrectionCount, 0);
    assert.match(initial.revision, /^sha256:[a-f0-9]{64}$/);

    const source = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${eventId}/source?revision=${initial.revision}`,
      headers: { cookie: session.cookie },
    });
    assert.deepEqual(source.json(), {
      status: 'ready',
      sources: [
        {
          label: 'Event source',
          occurredAt: 90,
          canOpen: true,
          threadId: 'thread-event-source',
          messageId: 'message-event-source',
        },
      ],
    });

    const correctCommand = {
      action: 'correct',
      requestId: 'event-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: initial.revision,
      patch: { summary: 'The corrected event summary.' },
    };
    const corrected = await postAction(eventId, correctCommand);
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.equal(corrected.json().outcome, 'applied');
    assert.notEqual(corrected.json().revision, initial.revision);
    const replay = await postAction(eventId, correctCommand);
    assert.equal(replay.json().outcome, 'replayed');

    const retired = await postAction(eventId, {
      action: 'retire',
      requestId: 'event-retire:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: corrected.json().revision,
    });
    assert.equal(retired.json().status, 'retired');

    const forgotten = await postAction(eventId, {
      action: 'hard_forget',
      requestId: 'event-forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: retired.json().revision,
      confirmed: true,
    });
    assert.equal(forgotten.statusCode, 200, forgotten.body);
    assert.equal(forgotten.json().forgetScope.originalSource, 'preserved');
    assert.equal(store.getEvent(eventId), null);
    const reingested = store.markEvent(record(), ownerUserId);
    assert.deepEqual(reingested, { event: null, inserted: false, suppressed: true });
    assert.equal(store.listEvents({ ownerUserId }).length, 0);
  });

  it('attaches pending source-bound corrections to Event detail and applies them only after owner approval', async () => {
    const event = store.markEvent(record(), ownerUserId).event;
    const initial = (
      await app.inject({
        method: 'GET',
        url: `/api/memory/events/${event.eventId}`,
        headers: { cookie: session.cookie },
      })
    ).json();
    const proposal = await proposalStore.create({
      proposalId: 'proposal-event-correction-1',
      eventId: event.eventId,
      expectedRevision: initial.revision,
      reason: 'unsupported_by_source',
      suggestedPatch: { summary: 'A source-supported event summary.' },
      ownerUserId,
      sourceCatId: 'codex-sol',
      sourceThreadId: 'thread-suggestion',
      sourceInvocationId: 'invocation-suggestion',
      source: { threadId: event.threadId, messageId: event.messageId },
      clientRequestId: 'event-correction:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      approvalOriginRef: { kind: 'event', anchor: 'invocation:invocation-suggestion', summary: 'Correction' },
    });
    await proposalStore.commitEnvelope(proposal.proposalId, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F321',
      ownerUserId,
      requesterCatId: proposal.sourceCatId,
      originRef: proposal.approvalOriginRef,
      approvalCardRef: { threadId: proposal.sourceThreadId, messageId: 'message-card' },
      createdAt: proposal.createdAt,
    });

    const listed = await app.inject({ method: 'GET', url: '/api/memory/events', headers: { cookie: session.cookie } });
    assert.equal(listed.json().events[0].pendingCorrectionCount, 1);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${event.eventId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(detail.json().correctionProposals[0].proposalId, proposal.proposalId);
    assert.equal(detail.json().correctionProposals[0].expectedRevision, initial.revision);
    assert.deepEqual(detail.json().correctionProposals[0].source, {
      threadId: event.threadId,
      messageId: event.messageId,
    });

    const approved = await app.inject({
      method: 'POST',
      url: `/api/event-memory-corrections/${proposal.proposalId}/approve`,
      headers: ownerHeaders(),
      payload: {},
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'approved');
    assert.equal(store.getEvent(event.eventId).summary, 'A source-supported event summary.');
    const after = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${event.eventId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(after.json().pendingCorrectionCount, 0);
    assert.deepEqual(after.json().correctionProposals, []);
  });

  it('revision-fences every oversized slice so equal-length corrections cannot mix snapshots', async () => {
    const eventId = store.markEvent(record({ summary: 'x'.repeat(250_000) }), ownerUserId).event.eventId;
    const detail = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${eventId}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(detail.statusCode, 200);
    const envelope = detail.json();
    assert.equal(envelope.oversized, true);
    assert.match(envelope.revision, /^sha256:[a-f0-9]{64}$/);

    const unbound = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${eventId}?charOffset=0`,
      headers: { cookie: session.cookie },
    });
    assert.equal(unbound.statusCode, 400);

    const firstSlice = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${eventId}?charOffset=0&revision=${envelope.revision}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(firstSlice.statusCode, 200);
    assert.equal(firstSlice.json().revision, envelope.revision);
    assert.equal(firstSlice.json().charOffset, 0);

    const corrected = await postAction(eventId, {
      action: 'correct',
      requestId: 'event-long-correct:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      expectedRevision: envelope.revision,
      patch: { summary: 'y'.repeat(250_000) },
    });
    assert.equal(corrected.statusCode, 200, corrected.body);

    const staleSlice = await app.inject({
      method: 'GET',
      url: `/api/memory/events/${eventId}?charOffset=${firstSlice.json().nextCharOffset}&revision=${envelope.revision}`,
      headers: { cookie: session.cookie },
    });
    assert.equal(staleSlice.statusCode, 409);
    assert.deepEqual(staleSlice.json(), { error: 'Revision changed' });
  });
});
