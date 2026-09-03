import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { CustodyOfferService } from '../../dist/domains/growing/CustodyOfferService.js';

function appendSource(store, overrides = {}) {
  return store.append({
    userId: 'owner-1',
    catId: null,
    content: 'Please hold tomorrow presentation.',
    contentBlocks: [{ type: 'text', text: 'Please hold tomorrow presentation.' }],
    mentions: [],
    timestamp: 1_788_168_300_000,
    threadId: 'thread-source',
    ...overrides,
  });
}

function pendingInput(message) {
  return {
    sourceMessageId: message.id,
    sourceMessageRevision: deriveGrowingSourceMessageRevision(message),
    offerId: 'offer-1',
    policyVersion: 'custody-recognition-v1',
    reasonCode: 'future_deliverable',
  };
}

describe('F310 source-owned custody offer service', () => {
  test('source revision canonically covers persisted content and blocks only', () => {
    const left = deriveGrowingSourceMessageRevision({
      content: 'same source',
      contentBlocks: [{ type: 'text', text: 'same source' }],
      extra: { tracing: { traceId: 'ignored-left' } },
    });
    const right = deriveGrowingSourceMessageRevision({
      content: 'same source',
      contentBlocks: [{ text: 'same source', type: 'text' }],
      extra: { tracing: { traceId: 'ignored-right' } },
    });
    const changed = deriveGrowingSourceMessageRevision({
      content: 'changed source',
      contentBlocks: [{ type: 'text', text: 'same source' }],
    });

    assert.equal(left, right);
    assert.notEqual(left, changed);
  });

  test('concurrent accept/decline has one source-state winner', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    const admissions = [];
    const left = new CustodyOfferService(store, {
      admitOrResumeAcceptedOffer: async (command) => {
        admissions.push(command);
        return {
          result: 'admitted',
          subjectRef: 'task:tomorrows-ppt',
          ownerRef: 'task',
          revision: 1,
          receiptRef: 'task-receipt:1',
        };
      },
    });
    const right = new CustodyOfferService(store);
    const pending = pendingInput(source);
    assert.equal((await left.recordPendingOffer(pending)).kind, 'recorded');

    const [accept, decline] = await Promise.all([
      left.acceptOffer({
        sourceMessageId: source.id,
        sourceMessageRevision: pending.sourceMessageRevision,
        offerId: pending.offerId,
        actorRef: 'user:owner-1',
        dispositionAt: source.timestamp + 1,
        idempotencyKey: 'custody:offer-1',
      }),
      right.refuseOffer({
        sourceMessageId: source.id,
        sourceMessageRevision: pending.sourceMessageRevision,
        offerId: pending.offerId,
        disposition: 'declined',
        actorRef: 'user:owner-1',
        dispositionAt: source.timestamp + 1,
      }),
    ]);

    assert.equal(
      [accept, decline].filter((result) => result.transitioned === true).length,
      1,
      'only one pending disposition may win',
    );
    const stored = store.getById(source.id).extra.custodyOfferV1;
    assert.ok(['accepted', 'declined'].includes(stored.disposition));
    assert.equal(admissions.length, stored.disposition === 'accepted' ? 1 : 0);
  });

  test('a later service reconstructs terminal disposition from the exact source record', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    const pending = pendingInput(source);
    const firstInvocation = new CustodyOfferService(store);
    await firstInvocation.recordPendingOffer(pending);
    await firstInvocation.refuseOffer({
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      disposition: 'dismissed',
      actorRef: 'user:owner-1',
      dispositionAt: source.timestamp + 2,
    });

    const laterInvocation = new CustodyOfferService(store);
    const read = await laterInvocation.readOffer(source.id);

    assert.equal(read.kind, 'found');
    assert.equal(read.offer.disposition, 'dismissed');
    assert.equal(read.offer.offerId, pending.offerId);
  });

  test('generic updateExtra cannot overwrite or create custodyOfferV1', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    const service = new CustodyOfferService(store);
    const pending = pendingInput(source);
    await service.recordPendingOffer(pending);
    const forged = {
      ...store.getById(source.id).extra.custodyOfferV1,
      disposition: 'declined',
      actorRef: 'attacker',
      dispositionAt: source.timestamp + 3,
    };

    store.updateExtra(source.id, {
      custodyOfferV1: forged,
      tracing: { traceId: 'trace-1', spanId: 'span-1' },
    });

    const stored = store.getById(source.id);
    assert.equal(stored.extra.custodyOfferV1.disposition, 'pending');
    assert.deepEqual(stored.extra.tracing, { traceId: 'trace-1', spanId: 'span-1' });

    const plain = appendSource(store, { content: 'No delegation', timestamp: source.timestamp + 4 });
    store.updateExtra(plain.id, { custodyOfferV1: forged });
    assert.equal(store.getById(plain.id).extra?.custodyOfferV1, undefined);
  });

  test('stale source revision and stale expected offer state fail closed', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    const service = new CustodyOfferService(store);
    const pending = pendingInput(source);

    const staleSource = await service.recordPendingOffer({
      ...pending,
      sourceMessageRevision: `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(staleSource.kind, 'stale_source');
    assert.equal(store.getById(source.id).extra?.custodyOfferV1, undefined);

    await service.recordPendingOffer(pending);
    const expectedPending = store.getById(source.id).extra.custodyOfferV1;
    await service.refuseOffer({
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      disposition: 'declined',
      actorRef: 'user:owner-1',
      dispositionAt: source.timestamp + 5,
    });
    const staleTransition = store.compareAndTransitionCustodyOffer(source.id, {
      expectedSourceMessageRevision: pending.sourceMessageRevision,
      expectedOffer: expectedPending,
      nextOffer: {
        ...expectedPending,
        disposition: 'dismissed',
        actorRef: 'user:owner-1',
        dispositionAt: source.timestamp + 6,
      },
    });
    assert.equal(staleTransition.kind, 'state_conflict');
    assert.equal(store.getById(source.id).extra.custodyOfferV1.disposition, 'declined');
  });

  test('terminal decline replay makes zero Task admission calls', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    let admissionCalls = 0;
    const service = new CustodyOfferService(store, {
      admitOrResumeAcceptedOffer: async () => {
        admissionCalls += 1;
        throw new Error('decline must never reach Task admission');
      },
    });
    const pending = pendingInput(source);
    await service.recordPendingOffer(pending);
    const decision = {
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      disposition: 'declined',
      actorRef: 'user:owner-1',
      dispositionAt: source.timestamp + 7,
    };

    const first = await service.refuseOffer(decision);
    const replay = await service.refuseOffer(decision);

    assert.equal(first.kind, 'declined');
    assert.equal(first.transitioned, true);
    assert.equal(replay.kind, 'declined');
    assert.equal(replay.transitioned, false);
    assert.equal(admissionCalls, 0);
  });

  test('accepted replay reuses the admission result and rejects a different idempotency key', async () => {
    const store = new MessageStore();
    const source = appendSource(store);
    let admissionCalls = 0;
    const service = new CustodyOfferService(store, {
      admitOrResumeAcceptedOffer: async () => {
        admissionCalls += 1;
        return {
          result: 'resumed',
          subjectRef: 'task:tomorrows-ppt',
          ownerRef: 'task',
          revision: 2,
          receiptRef: 'task-receipt:2',
        };
      },
    });
    const pending = pendingInput(source);
    await service.recordPendingOffer(pending);
    const accept = {
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      actorRef: 'user:owner-1',
      dispositionAt: source.timestamp + 8,
      idempotencyKey: 'custody:offer-1',
    };

    const first = await service.acceptOffer(accept);
    const replay = await service.acceptOffer(accept);
    const wrongKey = await service.acceptOffer({ ...accept, idempotencyKey: 'custody:different' });

    assert.equal(first.kind, 'accepted');
    assert.equal(first.offer.admission.state, 'resulted');
    assert.equal(replay.kind, 'accepted');
    assert.equal(replay.transitioned, false);
    assert.equal(wrongKey.kind, 'conflict');
    assert.equal(admissionCalls, 1);
  });

  test('needs_clarification retries the Task owner with the same source key and replaces only the result', async () => {
    const store = new MessageStore();
    const source = appendSource(store, { content: '', contentBlocks: [] });
    const admissionCommands = [];
    const service = new CustodyOfferService(store, {
      admitOrResumeAcceptedOffer: async (command) => {
        admissionCommands.push(command);
        if (!command.taskDraft) {
          return {
            result: 'needs_clarification',
            clarificationReason: 'An intended outcome and closure signal are required.',
          };
        }
        return {
          result: 'admitted',
          subjectRef: 'task:clarified-ppt',
          ownerRef: 'task:item:clarified-ppt',
          revision: 1,
          receiptRef: 'task:receipt:clarified-ppt',
        };
      },
    });
    const pending = pendingInput(source);
    await service.recordPendingOffer(pending);
    const accepted = await service.acceptOffer({
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      actorRef: 'user:owner-1',
      dispositionAt: source.timestamp + 9,
      idempotencyKey: 'custody:offer-1',
    });
    assert.equal(accepted.offer.admission.result.result, 'needs_clarification');

    const retried = await service.retryAcceptedAdmission({
      sourceMessageId: source.id,
      sourceMessageRevision: pending.sourceMessageRevision,
      offerId: pending.offerId,
      taskDraft: {
        title: 'Prepare the presentation',
        why: 'Clarified in the same source conversation',
        intendedOutcome: 'A reviewable presentation is ready',
        closure: {
          condition: 'The presentation is ready for review',
          expectedSignal: 'artifact:final-presentation',
        },
      },
    });

    assert.equal(retried.kind, 'accepted');
    assert.equal(retried.offer.admission.state, 'resulted');
    assert.equal(retried.offer.admission.idempotencyKey, 'custody:offer-1');
    assert.equal(retried.offer.admission.result.result, 'admitted');
    assert.equal(admissionCommands.length, 2);
    assert.equal(admissionCommands[1].idempotencyKey, admissionCommands[0].idempotencyKey);
    assert.deepEqual(admissionCommands[1].taskDraft, {
      title: 'Prepare the presentation',
      why: 'Clarified in the same source conversation',
      intendedOutcome: 'A reviewable presentation is ready',
      closure: {
        condition: 'The presentation is ready for review',
        expectedSignal: 'artifact:final-presentation',
      },
    });
  });
});
