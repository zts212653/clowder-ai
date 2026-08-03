import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  assertQueueCustodyTransition,
  assertQueuedMessageCustody,
  parseQueuedMessageCustody,
} from '../dist/domains/cats/services/stores/ports/queued-message-custody.js';
import {
  markReminderAttemptDelivered,
  markReminderAttemptMissed,
  markReminderAttemptSeen,
  projectQueueReceipt,
  requestReminderAttempt,
} from '../dist/domains/cats/services/stores/ports/queued-message-receipt.js';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-1',
    revision: 1,
    intent: 'execute',
    status: 'queued',
    allTargetCats: ['opus', 'codex', 'gpt52'],
    pendingTargetCats: ['opus', 'codex'],
    notifiedByCatIds: ['codex'],
    seenByCatIds: ['opus'],
    seenInvocationIdByCatId: { opus: 'inv-current' },
    bodyExposures: [
      { targetCatId: 'opus', invocationId: 'inv-current', seenAt: 1_200 },
      { targetCatId: 'gpt52', invocationId: 'inv-done', seenAt: 1_250 },
    ],
    failedByCatIds: [],
    handledByCatIds: ['gpt52'],
    targetOutcomeByCatId: {
      gpt52: {
        invocationId: 'inv-done',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-done' },
        handledAt: 1_500,
      },
    },
    reminderAttempts: [],
    priority: 'normal',
    createdAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  };
}

describe('F264 queue receipt projection', () => {
  test('distinguishes admitted, awakened, read, and invoked-but-unsettled target truth', () => {
    const admitted = custody({
      allTargetCats: ['opus'],
      pendingTargetCats: ['opus'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      bodyExposures: [],
      failedByCatIds: [],
      handledByCatIds: [],
      targetOutcomeByCatId: undefined,
    });
    assert.deepEqual(projectQueueReceipt(admitted).targets, [{ catId: 'opus', state: 'queued' }]);

    const awakened = custody({
      ...admitted,
      awakenedInvocationIdByCatId: { opus: 'child-opus' },
      awakenedAtByCatId: { opus: 1_100 },
    });
    assert.deepEqual(projectQueueReceipt(awakened).targets, [
      { catId: 'opus', state: 'awakened', invocationId: 'child-opus', awakenedAt: 1_100 },
    ]);

    const unsettled = custody({
      ...awakened,
      failedByCatIds: ['opus'],
    });
    assert.deepEqual(projectQueueReceipt(unsettled).targets, [
      { catId: 'opus', state: 'failed', invocationId: 'child-opus', awakenedAt: 1_100 },
    ]);
  });

  test('projects independent target truth and preserves completed-with-turn evidence', () => {
    assert.deepEqual(projectQueueReceipt(custody()), {
      version: 1,
      entryId: 'entry-1',
      targets: [
        { catId: 'opus', state: 'seen', invocationId: 'inv-current', seenAt: 1_200 },
        { catId: 'codex', state: 'notified' },
        {
          catId: 'gpt52',
          state: 'handled',
          invocationId: 'inv-done',
          seenAt: 1_250,
          outcome: {
            invocationId: 'inv-done',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-done' },
            handledAt: 1_500,
          },
        },
      ],
      reminderAttempts: [],
    });
  });

  test('validates typed terminal-silent and exact source-response consumption witnesses', () => {
    const terminalSilent = custody({
      targetOutcomeByCatId: {
        gpt52: {
          invocationId: 'inv-done',
          disposition: 'completed_with_turn',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-done' },
          handledAt: 1_500,
          consumption: {
            kind: 'terminal_silent',
            projectionState: 'covered_empty',
            wake: 'coordination_terminal',
          },
        },
      },
    });

    assert.deepEqual(projectQueueReceipt(terminalSilent).targets[2].outcome.consumption, {
      kind: 'terminal_silent',
      projectionState: 'covered_empty',
      wake: 'coordination_terminal',
    });

    terminalSilent.targetOutcomeByCatId.gpt52.consumption.wake = 'ordinary';
    assert.throws(() => assertQueuedMessageCustody(terminalSilent), /invalid target terminal consumption witness/);

    const sourceResponse = custody({
      targetOutcomeByCatId: {
        gpt52: {
          invocationId: 'inv-done',
          disposition: 'responded',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-done' },
          handledAt: 1_500,
          consumption: { kind: 'source_response', outputMessageIds: ['output-1'] },
        },
      },
    });
    assert.deepEqual(projectQueueReceipt(sourceResponse).targets[2].outcome.consumption, {
      kind: 'source_response',
      outputMessageIds: ['output-1'],
    });
    sourceResponse.targetOutcomeByCatId.gpt52.consumption.outputMessageIds.push('output-1');
    assert.throws(
      () => assertQueuedMessageCustody(sourceResponse),
      /source response consumption requires unique output message ids/,
    );
  });

  test('does not invent response evidence for legacy handled custody', () => {
    const receipt = projectQueueReceipt(custody({ targetOutcomeByCatId: undefined }));
    assert.deepEqual(receipt.targets[2], { catId: 'gpt52', state: 'handled' });
  });

  test('hydrates pre-exposure persisted outcomes as generic legacy handled truth', () => {
    const legacy = custody({ bodyExposures: undefined });

    const hydrated = parseQueuedMessageCustody(JSON.stringify(legacy));

    assert.equal(hydrated.targetOutcomeByCatId, undefined);
    assert.deepEqual(projectQueueReceipt(hydrated).targets[2], { catId: 'gpt52', state: 'handled' });
  });

  test('does not let legacy compatibility hide malformed outcome evidence', () => {
    const legacy = custody({
      bodyExposures: undefined,
      targetOutcomeByCatId: {
        gpt52: {
          invocationId: 'inv-done',
          disposition: 'responded',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-other' },
          handledAt: 1_500,
        },
      },
    });

    assert.throws(() => parseQueuedMessageCustody(JSON.stringify(legacy)), /matching invocation lineage evidence/);
  });

  test('keeps current-format outcomes strict when exact exposure evidence is absent', () => {
    const current = custody({ bodyExposures: [] });

    assert.throws(() => parseQueuedMessageCustody(JSON.stringify(current)), /matching exact body exposure/);
  });

  test('projects Steer separately from seen and failed states', () => {
    const receipt = projectQueueReceipt(
      custody({
        steerRequestedByCatIds: ['codex'],
        steeredInvocationIdByCatId: { opus: 'inv-steered' },
      }),
    );
    assert.deepEqual(receipt.targets[0], { catId: 'opus', state: 'steering', invocationId: 'inv-steered' });
    assert.deepEqual(receipt.targets[1], { catId: 'codex', state: 'steering' });
  });

  test('keeps exact exposure visible after a failed invocation returns responsibility to Queue', () => {
    const receipt = projectQueueReceipt(
      custody({
        seenInvocationIdByCatId: {},
        failedByCatIds: ['codex'],
        bodyExposures: [
          { targetCatId: 'codex', invocationId: 'inv-failed', seenAt: 1_350 },
          { targetCatId: 'opus', invocationId: 'inv-current', seenAt: 1_200 },
          { targetCatId: 'gpt52', invocationId: 'inv-done', seenAt: 1_250 },
        ],
      }),
    );

    assert.deepEqual(receipt.targets[1], {
      catId: 'codex',
      state: 'failed',
      invocationId: 'inv-failed',
      seenAt: 1_350,
    });
  });

  test('same-millisecond retries project the later appended child exposure', () => {
    const receipt = projectQueueReceipt(
      custody({
        seenInvocationIdByCatId: {},
        failedByCatIds: ['codex'],
        bodyExposures: [
          { targetCatId: 'opus', invocationId: 'inv-current', seenAt: 1_200 },
          { targetCatId: 'gpt52', invocationId: 'inv-done', seenAt: 1_250 },
          { targetCatId: 'codex', invocationId: 'inv-failed-old', seenAt: 1_350 },
          { targetCatId: 'codex', invocationId: 'inv-failed-new', seenAt: 1_350 },
        ],
      }),
    );

    assert.deepEqual(receipt.targets[1], {
      catId: 'codex',
      state: 'failed',
      invocationId: 'inv-failed-new',
      seenAt: 1_350,
    });
  });

  test('hydrates mixed legacy and child-exact targets without inventing a seenAt for the legacy target', () => {
    const mixed = custody({
      notifiedByCatIds: [],
      seenByCatIds: ['opus', 'codex'],
      seenInvocationIdByCatId: { opus: 'inv-current', codex: 'legacy-parent-invocation' },
    });

    assert.doesNotThrow(() => assertQueuedMessageCustody(mixed));
    const receipt = projectQueueReceipt(mixed);
    assert.deepEqual(receipt.targets[0], {
      catId: 'opus',
      state: 'seen',
      invocationId: 'inv-current',
      seenAt: 1_200,
    });
    assert.deepEqual(receipt.targets[1], {
      catId: 'codex',
      state: 'seen',
      invocationId: 'legacy-parent-invocation',
    });
  });

  test('rejects mismatched lineage evidence instead of hydrating a false reply pointer', () => {
    assert.throws(
      () =>
        assertQueuedMessageCustody(
          custody({
            targetOutcomeByCatId: {
              gpt52: {
                invocationId: 'inv-done',
                disposition: 'responded',
                evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-other' },
                handledAt: 1_500,
              },
            },
          }),
        ),
      /matching invocation lineage evidence/,
    );
  });

  test('rejects a child-exact handled outcome without the matching body exposure', () => {
    assert.throws(
      () =>
        assertQueuedMessageCustody(
          custody({
            bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-current', seenAt: 1_200 }],
          }),
        ),
      /matching exact body exposure/,
    );
  });

  test('storage transition cannot erase an already-persisted handled outcome', () => {
    const current = custody();
    const next = structuredClone(current);
    next.revision += 1;
    next.targetOutcomeByCatId = undefined;
    assert.throws(
      () => assertQueueCustodyTransition(current, { expectedRevision: current.revision, next }),
      /target outcomes are append-only/,
    );
  });

  test('storage transition cannot erase or rewrite an exact body exposure', () => {
    const current = custody();
    const erased = structuredClone(current);
    erased.revision += 1;
    erased.bodyExposures = erased.bodyExposures.slice(1);
    assert.throws(
      () => assertQueueCustodyTransition(current, { expectedRevision: current.revision, next: erased }),
      /body exposures are append-only/,
    );

    const rewritten = structuredClone(current);
    rewritten.revision += 1;
    rewritten.bodyExposures[0].seenAt += 1;
    assert.throws(
      () => assertQueueCustodyTransition(current, { expectedRevision: current.revision, next: rewritten }),
      /body exposures are append-only/,
    );
  });
});

describe('F264 exact body exposure identity', () => {
  test('is idempotent by target and child invocation while preserving independent targets', () => {
    const queue = new InvocationQueue();
    const result = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-exposure',
      userId: 'user-exposure',
      content: 'one persisted body',
      source: 'user',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      priority: 'normal',
    });
    const entry = result.entry;

    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'child-opus-1', 1_100);
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'child-opus-1', 9_999);
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'codex', 'child-codex-1', 1_200);
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'child-opus-2', 1_300);

    assert.deepEqual(
      queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id).queuedBodyExposures,
      [
        { targetCatId: 'opus', invocationId: 'child-opus-1', seenAt: 1_100 },
        { targetCatId: 'codex', invocationId: 'child-codex-1', seenAt: 1_200 },
        { targetCatId: 'opus', invocationId: 'child-opus-2', seenAt: 1_300 },
      ],
      'duplicate exposure preserves the first exact seenAt while targets and retries remain independent',
    );
  });
});

describe('F264 manual reminder attempt', () => {
  test('is idempotent for one message/target/invocation and tells delivered, seen, missed apart', () => {
    const initial = custody({ reminderAttempts: [] });
    const requested = requestReminderAttempt(initial, {
      id: 'reminder-1',
      targetCatId: 'codex',
      invocationId: 'inv-current',
      requestedAt: 1_600,
    });
    const duplicate = requestReminderAttempt(requested, {
      id: 'reminder-duplicate',
      targetCatId: 'codex',
      invocationId: 'inv-current',
      requestedAt: 1_700,
    });
    assert.deepEqual(duplicate.reminderAttempts, requested.reminderAttempts);

    const delivered = markReminderAttemptDelivered(requested, 'codex', 'inv-current', 1_800);
    assert.equal(delivered.reminderAttempts[0].state, 'delivered');
    const seen = markReminderAttemptSeen(delivered, 'codex', 'inv-current', 1_900);
    assert.deepEqual(seen.reminderAttempts[0], {
      id: 'reminder-1',
      targetCatId: 'codex',
      invocationId: 'inv-current',
      state: 'seen',
      requestedAt: 1_600,
      deliveredAt: 1_800,
      seenAt: 1_900,
    });

    const missed = markReminderAttemptMissed(requested, 'inv-current', 2_000);
    assert.equal(missed.reminderAttempts[0].state, 'missed');
    assert.equal(missed.reminderAttempts[0].missedReason, 'invocation_ended_before_delivery');
    assert.equal(markReminderAttemptMissed(seen, 'inv-current', 2_000), seen, 'terminal attempt is immutable');
  });

  test('rejects reminder requests for a cat outside the immutable target set', () => {
    assert.throws(
      () =>
        requestReminderAttempt(custody(), {
          id: 'reminder-invalid',
          targetCatId: 'gemini',
          invocationId: 'inv-current',
          requestedAt: 1_600,
        }),
      /target cat is not part of queue custody/,
    );
  });

  test('rejects unknown persisted reminder states', () => {
    assert.throws(
      () =>
        assertQueuedMessageCustody(
          custody({
            reminderAttempts: [
              {
                id: 'reminder-invalid-state',
                targetCatId: 'codex',
                invocationId: 'inv-current',
                state: 'pretended_seen',
                requestedAt: 1_600,
              },
            ],
          }),
        ),
      /invalid reminder attempt state/,
    );
  });

  test('storage transition cannot regress a delivered reminder to requested', () => {
    const current = custody({
      reminderAttempts: [
        {
          id: 'reminder-monotonic',
          targetCatId: 'codex',
          invocationId: 'inv-current',
          state: 'delivered',
          requestedAt: 1_600,
          deliveredAt: 1_700,
        },
      ],
    });
    const next = structuredClone(current);
    next.revision += 1;
    next.reminderAttempts[0] = {
      id: 'reminder-monotonic',
      targetCatId: 'codex',
      invocationId: 'inv-current',
      state: 'requested',
      requestedAt: 1_600,
    };
    assert.throws(
      () => assertQueueCustodyTransition(current, { expectedRevision: current.revision, next }),
      /reminder attempts are append-only and monotonic/,
    );
  });
});

function createCustodiedEntry() {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const result = queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-1',
    userId: 'user-1',
    content: 'please keep the receipt',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.equal(result.outcome, 'enqueued');
  const entry = result.entry;
  const message = store.append({
    threadId: entry.threadId,
    userId: entry.userId,
    catId: null,
    content: entry.content,
    mentions: entry.targetCats,
    timestamp: entry.createdAt,
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
  });
  queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
  const persistedEntry = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
  assert.ok(persistedEntry);
  return { queue, store, entry: persistedEntry, message };
}

describe('F264 custody coordinator evidence', () => {
  test('persists exact handled disposition and lineage without deleting it at terminal delivery', async () => {
    const { queue, store, entry, message } = createCustodiedEntry();
    let now = entry.createdAt + 100;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => now });
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'inv-1', now);
    const seen = queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id);
    await coordinator.persistEntry(seen);

    now += 100;
    await coordinator.commitSuccessfulTargets(seen, ['opus'], 'inv-1', now, {
      opus: {
        invocationId: 'inv-1',
        disposition: 'responded',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
        handledAt: now,
      },
    });

    assert.deepEqual(store.getById(message.id).queueCustody.targetOutcomeByCatId, {
      opus: {
        invocationId: 'inv-1',
        disposition: 'responded',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
        handledAt: now,
      },
    });
    const persistedCustody = store.getById(message.id).queueCustody;
    assert.deepEqual(persistedCustody.bodyExposures, [
      { targetCatId: 'opus', invocationId: 'inv-1', seenAt: entry.createdAt + 100 },
    ]);
    assert.equal(
      persistedCustody.bodyExposures[0].seenAt < persistedCustody.targetOutcomeByCatId.opus.handledAt,
      true,
      'read time must precede terminal handled time',
    );
  });

  test('failed invocation retains seenAt while clearing only its active handled fence', async () => {
    const { queue, store, entry, message } = createCustodiedEntry();
    const seenAt = entry.createdAt + 100;
    queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, 'opus', 'inv-failed', seenAt);
    await new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => seenAt }).persistEntry(
      queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id),
    );

    queue.markQueuedFailedForCatAcrossUsers(entry.threadId, 'opus', 'inv-failed');
    await new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => seenAt + 10 }).persistEntry(
      queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id),
    );

    assert.deepEqual(projectQueueReceipt(store.getById(message.id).queueCustody).targets[0], {
      catId: 'opus',
      state: 'failed',
      invocationId: 'inv-failed',
      seenAt,
    });
  });

  test('persists requested, delivered, and seen reminder transitions through custody CAS', async () => {
    const { store, entry, message } = createCustodiedEntry();
    let now = entry.createdAt + 100;
    const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: store, now: () => now });

    await coordinator.requestReminder(entry, 'opus', 'inv-active', 'reminder-1');
    now += 100;
    await coordinator.markReminderDelivered(entry, 'opus', 'inv-active');
    now += 100;
    await coordinator.markReminderSeen(entry, 'opus', 'inv-active');

    assert.equal(
      (await coordinator.findReminderAttempt(entry, 'opus', 'inv-active')).id,
      'reminder-1',
      'idempotent endpoint lookup returns the durable attempt',
    );

    assert.deepEqual(store.getById(message.id).queueCustody.reminderAttempts, [
      {
        id: 'reminder-1',
        targetCatId: 'opus',
        invocationId: 'inv-active',
        state: 'seen',
        requestedAt: entry.createdAt + 100,
        deliveredAt: entry.createdAt + 200,
        seenAt: entry.createdAt + 300,
      },
    ]);
  });

  test('hydrates active QueuePanel rows from the same durable receipt projection', async () => {
    const { queue, store, entry } = createCustodiedEntry();
    await new QueuedMessageCustodyCoordinator({ messageStore: store }).requestReminder(
      entry,
      'opus',
      'inv-active',
      'reminder-active',
    );

    const [enriched] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.deepEqual(enriched.queueReceipt, {
      version: 1,
      entryId: entry.id,
      targets: [{ catId: 'opus', state: 'queued' }],
      reminderAttempts: [
        {
          id: 'reminder-active',
          targetCatId: 'opus',
          invocationId: 'inv-active',
          state: 'requested',
          requestedAt: enriched.queueReceipt.reminderAttempts[0].requestedAt,
        },
      ],
    });
  });
});
