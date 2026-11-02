import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RichInteractiveBlock, RuntimeInteractionRequest } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { MessageRuntimeInteractionCardPublisher } from '../src/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';
import type {
  CollectiveAccountabilityAttentionSourceRead,
  CollectiveAccountabilitySource,
} from '../src/routes/companion-collective-accountability-source.js';
import { readCompanionDecisionProjection } from '../src/routes/companion-decision-read-service.js';

// These cases isolate conversation decisions while every other source is fully read.
const readEmptyCollectiveAccountability: CollectiveAccountabilitySource = async () => ({
  status: 200,
  body: {
    data: {
      items: [],
      reasons: [],
      state: {
        coverage: 'pending_f290_collective_accountability_requests',
        startedAt: 1,
        observedAt: 2,
        status: 'available',
        exhaustiveness: 'complete',
      },
    } satisfies CollectiveAccountabilityAttentionSourceRead,
  },
});

const presentation: RichInteractiveBlock = {
  id: 'conversation-decision-block',
  kind: 'interactive',
  v: 1,
  interactiveType: 'select',
  title: 'Choose a release name',
  description: 'This remains answerable after the requesting turn ends.',
  options: [
    { id: 'sunrise', label: 'Sunrise' },
    { id: 'moonrise', label: 'Moonrise', customInput: true },
  ],
  messageTemplate: 'Release name: {selection}',
};

const request: RuntimeInteractionRequest = {
  version: 1,
  interactionId: 'conversation-decision-1',
  kind: 'conversation_decision',
  owner: {
    userId: 'owner',
    threadId: 'thread-1',
    catId: 'codex-sol',
    invocationId: 'requester-invocation',
  },
  createdAt: 1_000,
  title: 'Choose a release name',
  description: 'Pick the name that should travel with this release.',
  presentation,
  allowTextResponse: true,
  deadlineAt: 2_000,
};

async function createFixture() {
  const app = Fastify();
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const messages = new MessageStore();
  const interactions = new InMemoryRuntimeInteractionStore();
  const publisher = new MessageRuntimeInteractionCardPublisher({
    messageStore: messages,
    socketManager: { broadcastToRoom: () => undefined },
  });
  const staged = await interactions.createStaged({ request, hostEpoch: 'host-1', now: request.createdAt });
  const cardRef = await publisher.prepare(request);
  const pending = await interactions.anchor(
    request.interactionId,
    'host-1',
    cardRef,
    request.createdAt + 50,
    staged.revision,
  );
  assert.ok(pending);
  return { app, messages, interactions, pending, publisher };
}

test('F310 projects a live conversation decision with its monotonic CAS revision and original presentation', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());

  const result = await readCompanionDecisionProjection(
    fixture.app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    fixture.interactions,
    undefined,
    fixture.messages,
    readEmptyCollectiveAccountability,
  );

  assert.equal(result.status, 'available');
  assert.equal(result.totalCount, 1);
  assert.equal(result.attentionCount, 1);
  const item = result.items[0];
  assert.ok(item);
  assert.equal(item.choiceRequest, undefined, 'conversation decisions never masquerade as provider questions');
  const runtime = item.runtimeInteraction as unknown as
    | {
        sourceKind?: string;
        kind: string;
        revision: number;
        presentation?: RichInteractiveBlock;
        allowTextResponse?: boolean;
        deadlineAt?: number;
        cardRef: { blockDigest?: string; publishedAt?: number };
      }
    | undefined;
  assert.ok(runtime);
  assert.equal(runtime.sourceKind, 'conversation_decision');
  assert.equal(runtime.kind, 'conversation_decision');
  assert.equal(runtime.revision, fixture.pending.revision, 'the response writer consumes the record CAS revision');
  assert.notEqual(runtime.revision, fixture.pending.updatedAt, 'updatedAt is not a conversation CAS token');
  assert.deepEqual(runtime.presentation, presentation);
  assert.equal(runtime.allowTextResponse, true);
  assert.equal(runtime.deadlineAt, 2_000);
  assert.equal(runtime.cardRef.blockDigest, fixture.pending.cardRef?.blockDigest);
  assert.equal(runtime.cardRef.publishedAt, fixture.pending.cardRef?.publishedAt);
});

test('F310 isolates a dead conversation presentation without hiding live provider decisions', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());
  assert.ok(fixture.pending.cardRef);
  const providerRequest: RuntimeInteractionRequest = {
    version: 1,
    interactionId: 'provider-question-1',
    kind: 'question',
    owner: {
      userId: 'owner',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'provider-invocation',
    },
    provider: {
      providerId: 'openai',
      method: 'item/tool/requestUserInput',
      requestId: 'provider-request-1',
      threadId: 'provider-thread',
      turnId: 'provider-turn',
      itemId: 'provider-item',
    },
    createdAt: 1_010,
    title: 'Choose a target',
    questions: [{ id: 'target', header: 'Target', question: 'Where should this run?' }],
  };
  const providerStaged = await fixture.interactions.createStaged({
    request: providerRequest,
    hostEpoch: 'host-1',
    now: providerRequest.createdAt,
  });
  const providerCardRef = await fixture.publisher.prepare(providerRequest);
  await fixture.interactions.anchor(
    providerRequest.interactionId,
    'host-1',
    providerCardRef,
    providerRequest.createdAt + 1,
    providerStaged.revision,
  );
  fixture.messages.softDelete(fixture.pending.cardRef.messageId, 'owner');

  const result = await readCompanionDecisionProjection(
    fixture.app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    fixture.interactions,
    undefined,
    fixture.messages,
    readEmptyCollectiveAccountability,
  );

  assert.equal(result.status, 'available');
  assert.equal(result.sources.structuredChoices?.status, 'available');
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.runtimeInteraction?.interactionId, providerRequest.interactionId);
  assert.ok(result.items[0]?.choiceRequest);
  assert.deepEqual(result.consistency.reasons, ['runtime_interaction_presentation_unverified']);
  assert.equal(result.totalCount, undefined);
  assert.equal(result.attentionCount, undefined);
});

test('F310 stops offering a decision after its answer has won the durable submission claim', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.app.close());
  const claimed = await fixture.interactions.claimSubmission({
    interactionId: request.interactionId,
    expectedRevision: fixture.pending.revision,
    submission: {
      operationId: 'claimed-answer',
      responseDigest: 'claimed-answer-digest',
      author: 'owner',
      response: { kind: 'selection', selectedIds: ['sunrise'] },
      terminal: {
        status: 'answered',
        reasonCode: 'answered',
        settledAt: 1_100,
        operationId: 'claimed-answer',
        responseDigest: 'claimed-answer-digest',
      },
      claimedAt: 1_100,
    },
    now: 1_100,
  });
  assert.ok(claimed);

  const result = await readCompanionDecisionProjection(
    fixture.app,
    'owner',
    { offset: 0, limit: 20 },
    undefined,
    undefined,
    fixture.interactions,
    undefined,
    fixture.messages,
    readEmptyCollectiveAccountability,
  );

  assert.equal(result.status, 'available');
  assert.equal(result.items.length, 0);
  assert.equal(result.totalCount, 0);
  assert.equal(result.attentionCount, 0);
});
