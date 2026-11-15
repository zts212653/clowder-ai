import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ApprovalIngress } from '../../src/domains/approval-hub/ApprovalIngress.js';
import { InMemoryEntityProposalStore } from '../../src/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { EventMemoryStore, eventMemoryRevision } from '../../src/domains/memory/EventMemoryStore.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../../src/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import { registerCallbackAuthHook } from '../../src/routes/callback-auth-prehandler.js';
import { callbackProposeEntityRoutes } from '../../src/routes/callback-propose-entity-routes.js';
import { callbackProposeEventMemoryCorrectionRoutes } from '../../src/routes/callback-propose-event-memory-correction-routes.js';
import { registerCallbackRememberRoutes } from '../../src/routes/callback-remember-routes.js';

export async function memoryRetryFixture(kind: 'entity' | 'event') {
  const app = Fastify();
  const registry = new InvocationRegistry();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const owner = 'm3-retry-owner';
  const thread = threads.create(owner, 'Memory source');
  const origin = messages.append({
    userId: owner,
    threadId: thread.id,
    from: { kind: 'user', userId: owner },
    content: 'Keep this distinction',
    timestamp: Date.now(),
  });
  const socketManager = { emitToUser() {}, broadcastToRoom() {} };
  const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
  const entities = new InMemoryEntityProposalStore();
  const corrections = new InMemoryEventMemoryCorrectionProposalStore();
  const events = new EventMemoryStore(':memory:');
  await events.initialize();
  const event = events.markEvent(
    {
      type: 'scope_correction',
      trigger: 'human_brake',
      cat: 'opus',
      threadId: thread.id,
      messageId: origin.id,
      timestamp: Date.now(),
      summary: 'Original interpretation',
      cognitiveTransition: 'scope_correction',
      relatedHarness: ['F332'],
      confidence: 'high',
    },
    owner,
  ).event;
  assert.ok(event);
  if (kind === 'entity')
    await app.register(callbackProposeEntityRoutes, {
      registry,
      entityProposalStore: entities,
      messageStore: messages,
      socketManager,
      approvalIngress: ingress,
    });
  else
    await app.register(callbackProposeEventMemoryCorrectionRoutes, {
      registry,
      eventMemoryStore: events,
      proposalStore: corrections,
      sourceReaders: { threadStore: threads, messageStore: messages },
      approvalIngress: ingress,
    });
  // Cats reach both original routes only through cat_cafe_remember since 2026-11-13.
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, registry);
    registerCallbackRememberRoutes(scope, { registry, messageStore: messages, socketManager });
  });
  await app.ready();
  const input =
    kind === 'entity'
      ? {
          entityId: 'concept:m3-retry',
          entityType: 'concept',
          canonicalName: 'Retry identity',
          aliases: ['same request'],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          provenance: [{ source: 'thread', anchor: origin.id }],
          rationale: 'A stable shared term',
          clientRequestId: 'm3-entity-request',
        }
      : {
          eventId: event.eventId,
          expectedRevision: eventMemoryRevision(event),
          reason: 'unsupported_by_source',
          suggestedPatch: { summary: 'The narrower interpretation' },
          clientRequestId: 'm3-event-request:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
        };
  const auth = (source: { id: string } | null = origin, cat = 'opus', threadId = thread.id) =>
    registry.create(owner, cat, threadId, undefined, undefined, undefined, source?.id);
  const post = async (record: Awaited<ReturnType<typeof auth>>, payload = input) =>
    app.inject({
      method: 'POST',
      url: kind === 'entity' ? '/api/callbacks/propose-entity' : '/api/callbacks/propose-event-memory-correction',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload,
    });
  const get = async (id: string) => (kind === 'entity' ? entities.get(id) : corrections.get(id));
  const store = kind === 'entity' ? entities : corrections;
  return { app, registry, messages, threads, owner, thread, origin, input, auth, post, get, store, ingress };
}
