import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createAssistantReturnInbox } from '../src/plugins/cloud-cat-personal-host/native-host/assistant-return-inbox.mjs';

const revisions = {
  helper: `sha512:${'0'.repeat(128)}`,
  extension: '0.2.10',
  pageAdapter: '2026-09-02.1',
};

function observed() {
  return {
    v: 2,
    kind: 'assistant_final_observed',
    requestId: 'request-1',
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    hostMessageId: 'conversation-turn-41',
    assistantMessageId: 'conversation-turn-42',
    content: 'exact causal assistant final',
    observedRevisions: revisions,
  };
}

function observationFailure(overrides = {}) {
  return {
    v: 2,
    kind: 'assistant_observation_failed',
    requestId: 'request-failure-1',
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    hostMessageId: 'conversation-turn-41',
    errorCode: 'ASSISTANT_FINAL_NOT_OBSERVED',
    diagnostic: {
      v: 1,
      userTurnConnected: true,
      anchorTurnFound: true,
      followingTurnCount: 1,
      assistantCandidateCount: 1,
      laterUserTurnPresent: false,
      assistantHostIdStatus: 'missing_or_ambiguous',
      assistantContentStatus: 'present',
      streamingControlPresent: false,
    },
    observedRevisions: revisions,
    ...overrides,
  };
}

function ledgerEntry() {
  return {
    conversationId: 'conversation-7',
    idempotencyKey: 'source-message-9',
    submitted: true,
    hostMessageId: 'conversation-turn-41',
    expectedRevisions: revisions,
  };
}

function ack(entry) {
  return {
    v: 2,
    kind: 'ack_assistant_return',
    requestId: 'ack-terminal-return',
    conversationId: entry.conversationId,
    sourceMessageId: entry.idempotencyKey,
    assistantMessageId: 'conversation-turn-42',
  };
}

it('durably records an exact source-bound assistant observation failure without message content', async () => {
  const entry = ledgerEntry();
  let persistCount = 0;
  const inbox = createAssistantReturnInbox({
    ledger: new Map([['conversation-7\u0000source-message-9', entry]]),
    persist: async () => {
      persistCount += 1;
    },
    now: () => new Date('2026-09-02T13:28:00.000Z'),
  });

  assert.equal(await inbox.acceptObservationFailure(observationFailure()), 'accepted');
  assert.deepEqual(entry.assistantObservationFailure, {
    state: 'failed',
    errorCode: 'ASSISTANT_FINAL_NOT_OBSERVED',
    diagnostic: observationFailure().diagnostic,
    observedAt: '2026-09-02T13:28:00.000Z',
  });
  assert.equal(JSON.stringify(entry.assistantObservationFailure).includes('must never be persisted'), false);
  assert.equal(persistCount, 1);

  assert.equal(await inbox.acceptObservationFailure(observationFailure()), 'accepted');
  assert.equal(persistCount, 1, 'an exact retry must not rewrite the durable observation failure');
  assert.equal(await inbox.acceptObserved(observed()), 'rejected');
  assert.equal(entry.assistantReturn, undefined);

  assert.equal(
    await inbox.acceptObservationFailure(
      observationFailure({
        diagnostic: { ...observationFailure().diagnostic, content: 'must never be persisted' },
      }),
    ),
    'rejected',
  );
  assert.equal(persistCount, 1);
  assert.equal(
    await inbox.acceptObservationFailure(observationFailure({ hostMessageId: 'conversation-turn-forged' })),
    'rejected',
  );
  assert.equal(persistCount, 1);
});

it('keeps an ACKed assistant final terminal against delayed observer outcomes and rolls ACK failures back', async () => {
  const entry = ledgerEntry();
  let persistCount = 0;
  const inbox = createAssistantReturnInbox({
    ledger: new Map([['conversation-7\u0000source-message-9', entry]]),
    persist: async () => {
      persistCount += 1;
    },
    now: () => new Date('2026-09-02T13:29:00.000Z'),
  });

  assert.equal(await inbox.acceptObserved(observed()), 'accepted');
  assert.equal((await inbox.handleLocalRequest(ack(entry))).status, 'acknowledged');
  assert.equal(entry.assistantReturn, undefined);
  assert.equal(entry.assistantReturnAckedAt, '2026-09-02T13:29:00.000Z');
  assert.equal(await inbox.acceptObservationFailure(observationFailure()), 'rejected');
  assert.equal(await inbox.acceptObserved(observed()), 'rejected');
  assert.equal(entry.assistantObservationFailure, undefined);
  assert.equal(entry.assistantReturn, undefined);
  assert.equal(persistCount, 2, 'late observer outcomes must not rewrite an ACKed terminal entry');

  const rollbackEntry = ledgerEntry();
  let rejectNextPersist = false;
  let rollbackPersistCount = 0;
  const rollbackInbox = createAssistantReturnInbox({
    ledger: new Map([['conversation-7\u0000source-message-9', rollbackEntry]]),
    persist: async () => {
      rollbackPersistCount += 1;
      if (rejectNextPersist) throw new Error('simulated ACK persistence failure');
    },
  });

  assert.equal(await rollbackInbox.acceptObserved(observed()), 'accepted');
  rejectNextPersist = true;
  await assert.rejects(rollbackInbox.handleLocalRequest(ack(rollbackEntry)), /simulated ACK persistence failure/);
  assert.equal(rollbackEntry.assistantReturn?.assistantMessageId, 'conversation-turn-42');
  assert.equal(rollbackEntry.assistantReturnAckedAt, undefined);
  assert.equal(await rollbackInbox.acceptObserved(observed()), 'accepted');
  assert.equal(await rollbackInbox.acceptObservationFailure(observationFailure()), 'rejected');
  assert.equal(rollbackEntry.assistantObservationFailure, undefined);
  assert.equal(rollbackPersistCount, 2, 'replays after rollback must not rewrite the restored pending return');
});
