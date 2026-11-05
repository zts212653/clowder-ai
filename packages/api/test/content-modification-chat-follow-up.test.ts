import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  ContentModificationAcceptance,
  ContentModificationRecord,
  ContentWritebackReceipt,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
// The persisted Queue fixture loads its ledger from dist; use the same module
// graph for atomic in-memory admission instead of mixing two class identities.
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { PersistedQueueDeliveryInput } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { queueEntryId } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { assembleContext } from '../src/domains/cats/services/context/ContextAssembler.js';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { canViewMessage } from '../src/domains/cats/services/stores/visibility.js';
import { ContentModificationChatProjection } from '../src/domains/collaborative-content/modification/chat-projection.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { createPersistedQueueFixture } from './helpers/persisted-queue-fixture.js';
import './helpers/setup-cat-registry.js';

const requestId = `f309-modification-${'a'.repeat(64)}`;
const revision = `sha256:${'b'.repeat(64)}` as const;
const targetCatId = 'codex-astra';
const outsiderCatId = 'opus55';

for (const state of ['conflict', 'unknown'] as const) {
  for (const visibility of ['public', 'whisper'] as const) {
    test(`${visibility} ${state} follow-up preserves Host attribution and the frozen audience through Queue settlement`, async (t) => {
      const messages = new MessageStore();
      const threads = new ThreadStore();
      const thread = threads.create('operator', 'F309 follow-up audience');
      threads.updateThinkingMode(thread.id, 'play');
      const source = messages.append({
        userId: 'operator',
        from: { kind: 'user', userId: 'operator' },
        threadId: thread.id,
        content: 'Please update the private document.',
        mentions: [targetCatId],
        timestamp: Date.now(),
        ...(visibility === 'whisper' ? { visibility, whisperTo: [targetCatId] } : {}),
      });
      const record = modificationRecord(thread.id, source.id, source.timestamp, visibility);
      const live = createPersistedQueueFixture(messages);
      t.after(live.close);
      const projection = new ContentModificationChatProjection({
        messages,
        tasks: {
          get: async () => ({
            id: 'task-open',
            userId: 'operator',
            threadId: thread.id,
            ownerCatId: targetCatId,
            status: 'todo',
            entrustedWork: { closure: { state: 'open' } },
          }),
        },
        delivery: live.delivery,
        onSaved: () => {},
        onError: (error) => assert.fail(String(error)),
      });

      const projected = await projection.projectWriteback(record, acceptance(source.timestamp), writeback(state));
      assert.ok(projected);
      const carrier = messages
        .getByThread(thread.id, 100, 'operator', { includeQueuedUserMessages: true })
        .find((message) => message.source?.connector === 'content-modification-result');
      assert.ok(carrier);
      assert.equal(Object.hasOwn(carrier, 'queueCustody'), false);
      assert.equal(carrier.visibility ?? 'public', visibility);
      assert.deepEqual(carrier.whisperTo ?? [], visibility === 'whisper' ? [targetCatId] : []);
      assert.deepEqual(carrier.source?.meta, {
        v: 1,
        requestId,
        sourceMessageId: source.id,
        targetCatId,
        taskId: 'task-open',
        candidateRef: 'content-patch:request:1',
        receiptRef: `writeback-${state}`,
        state,
      });

      const awakenedId = await live.waitForAwakening(carrier.id);
      const entryId = queueEntryId(carrier.id);
      assert.equal(await live.queue.getDurableEntry(thread.id, entryId), null);
      assert.equal(live.starts.length, 1);
      assert.equal(live.starts[0].invocationId, awakenedId);
      assert.equal(messages.getById(carrier.id)?.deliveryStatus, 'delivered');

      const exactDelivery = deliveryInput(carrier, state, visibility);
      const replay = await live.delivery.deliver(exactDelivery);
      assert.notEqual(replay.state, 'conflict');
      assert.equal(replay.message?.id, carrier.id);
      const wrongAudience = await live.delivery.deliver(
        deliveryInput(carrier, state, visibility === 'public' ? 'whisper' : 'public'),
      );
      assert.equal(wrongAudience.state, 'conflict', 'replay cannot inherit a carrier with a different audience');
      const wrongAttribution = await live.delivery.deliver({
        ...exactDelivery,
        source: { ...exactDelivery.source, label: '作品修改结果' },
      });
      assert.equal(wrongAttribution.state, 'conflict', 'replay cannot inherit a carrier with different Host identity');

      const app = Fastify();
      t.after(() => app.close());
      const registry = new InvocationRegistry();
      const cursor = new DeliveryCursorStore();
      await app.register(callbacksRoutes, {
        registry,
        messageStore: messages,
        threadStore: threads,
        deliveryCursorStore: cursor,
        socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
        evidenceStore: { search: async () => [] },
        reflectionService: { reflect: async () => '' },
        markerQueue: { submit: async () => ({}), list: async () => [] },
      });

      const outsider = await readAs(app, registry, thread.id, outsiderCatId);
      if (visibility === 'public') {
        assertHostCarrier(outsider.history, carrier.id);
        assertHostCarrier(outsider.unread, carrier.id);
      } else {
        assert.ok(!outsider.history.some((message) => message.id === carrier.id));
        assert.ok(!outsider.unread.some((message) => message.id === carrier.id));
        assert.equal(canViewMessage(carrier, { type: 'cat', catId: outsiderCatId }), false);
      }
      const target = await readAs(app, registry, thread.id, targetCatId);
      assertHostCarrier(target.history, carrier.id);
      assertHostIfPresent(target.unread, carrier.id);

      const targetPrompt = promptFor(messages, thread.id, targetCatId);
      assert.match(targetPrompt, /Host 作品修改结果续办/);
      assert.doesNotMatch(targetPrompt, /co-creator.*作品修改结果续办/);
      if (visibility === 'whisper')
        assert.doesNotMatch(promptFor(messages, thread.id, outsiderCatId), /作品修改结果续办/);
    });
  }
}

function modificationRecord(
  threadId: string,
  sourceMessageId: string,
  timestamp: number,
  visibility: 'public' | 'whisper',
): ContentModificationRecord {
  return {
    requestId,
    ownerUserId: 'operator',
    revision: 5,
    createdAt: timestamp,
    updatedAt: timestamp,
    payload: {
      operationId: '11111111-1111-4111-8111-111111111111',
      targetCatId,
      threadId,
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        expectedSourceRevision: revision,
        reviewId: 'review-1',
        expectedReviewRevision: 1,
      },
      intent: { body: 'Please update the private document.' },
    },
    progress: {
      sourceMessageId,
      sourceKind: 'human_message',
      sourceMessageRevision: `sha256:${'c'.repeat(64)}`,
      sourceVisibility: visibility === 'whisper' ? { visibility, whisperTo: [targetCatId] } : { visibility: 'public' },
      prepared: { kind: 'text', reviewId: 'review-1', sourceRevision: revision },
      task: { taskId: 'task-open', revision: 1, receiptRef: 'task-receipt' },
      review: { reviewId: 'review-1', receiptRef: `${requestId}#request` },
    },
  };
}

function acceptance(timestamp: number): ContentModificationAcceptance {
  return {
    requestId,
    ownerUserId: 'operator',
    candidateRef: 'content-patch:request:1',
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    baseRevision: revision,
    locator: { worktreeId: 'work', path: 'guide.md' },
    humanReceiptRef: 'human-accept',
    fileReceiptRef: 'writeback-conflict',
    acceptedAt: timestamp + 2,
  };
}

function writeback(state: 'conflict' | 'unknown'): ContentWritebackReceipt {
  return {
    requestId,
    ownerUserId: 'operator',
    candidateRef: 'content-patch:request:1',
    acceptOperationId: '33333333-3333-4333-8333-333333333333',
    baseRevision: revision,
    candidateRevision: `sha256:${'d'.repeat(64)}`,
    locator: { worktreeId: 'work', path: 'guide.md' },
    receiptRef: `writeback-${state}`,
    state,
  };
}

function deliveryInput(
  carrier: NonNullable<ReturnType<MessageStore['getById']>>,
  state: 'conflict' | 'unknown',
  visibility: 'public' | 'whisper',
): PersistedQueueDeliveryInput {
  assert.ok(carrier.source);
  const common = {
    ownerAuthProvenance: 'strict' as const,
    ownerUserId: 'operator',
    threadId: carrier.threadId,
    targetCatId,
    idempotencyKey: `f309-result-follow-up:${createHash('sha256').update(`writeback-${state}`).digest('hex')}`,
    content: carrier.content,
    source: carrier.source,
    from: carrier.from,
    sourceCategory: 'producer_return' as const,
  };
  return visibility === 'whisper' ? { ...common, visibility, whisperTo: [targetCatId] } : { ...common, visibility };
}

async function readAs(app: ReturnType<typeof Fastify>, registry: InvocationRegistry, threadId: string, catId: string) {
  const auth = await registry.create('operator', catId, threadId);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const unread = await app.inject({
    method: 'GET',
    url: '/api/callbacks/thread-context?responseMode=full&readIntent=unread',
    headers,
  });
  assert.equal(unread.statusCode, 200, unread.body);
  const history = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers });
  assert.equal(history.statusCode, 200, history.body);
  return { history: history.json().messages, unread: unread.json().messages } as {
    history: { id: string; speaker: string }[];
    unread: { id: string; speaker: string }[];
  };
}

function assertHostCarrier(messages: { id: string; speaker: string }[], messageId: string) {
  assert.equal(messages.find((message) => message.id === messageId)?.speaker, 'Host 作品修改结果续办');
}

function assertHostIfPresent(messages: { id: string; speaker: string }[], messageId: string) {
  const carrier = messages.find((message) => message.id === messageId);
  if (carrier) assert.equal(carrier.speaker, 'Host 作品修改结果续办');
}

function promptFor(messages: MessageStore, threadId: string, catId: string) {
  const visible = messages
    .getByThread(threadId, 100, 'operator')
    .filter((message) => canViewMessage(message, { type: 'cat', catId }));
  return assembleContext(visible, { maxTotalTokens: 20_000 }).contextText;
}
