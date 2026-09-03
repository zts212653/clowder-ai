import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionWake as dispatchWake,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

const COORDINATION_ID = 'coord-terminal-retirement';

function bindActiveCoordination(h) {
  h.source.extra = {
    crossPost: {
      sourceThreadId: 'thread-origin',
      sourceInvocationId: 'origin-invocation',
    },
    coordination: {
      id: COORDINATION_ID,
      phase: 'active',
      hop: 1,
      subjectRef: 'task:terminal-retirement',
    },
    targetCats: ['codex-sol'],
  };
}

function appendTerminal(h, overrides = {}) {
  return h.messageStore.append({
    userId: 'user-1',
    catId: createCatId('codex-sol'),
    content: '@fable5 terminal result',
    mentions: [createCatId('fable5')],
    timestamp: 1_750,
    threadId: 'thread-origin',
    origin: 'callback',
    deliveryStatus: 'queued',
    extra: {
      crossPost: {
        sourceThreadId: 'thread-1',
        sourceInvocationId: 'inv-1',
      },
      coordination: {
        id: COORDINATION_ID,
        phase: 'terminal',
        hop: 2,
        subjectRef: 'task:terminal-retirement',
      },
      causal: {
        kind: 'invocation_reply',
        triggerMessageId: h.source.id,
      },
      stream: {
        invocationId: 'inv-1',
        turnInvocationId: 'inv-1',
      },
      targetCats: ['fable5'],
      ...overrides,
    },
  });
}

describe('coordination terminal → ordinary A2A dispatch retirement', () => {
  test('one consumed terminal retires the exact dispatch fence and both completion paths replay', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));
    const terminal = appendTerminal(h);
    const queue = new InvocationQueue();
    const enqueued = queue.enqueue({
      threadId: terminal.threadId,
      userId: terminal.userId,
      ownerAuthProvenance: 'unknown',
      content: terminal.content,
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['fable5'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex-sol',
      a2aParentInvocationId: 'inv-1',
      a2aTriggerMessageId: terminal.id,
    });
    assert.equal(enqueued.outcome, 'enqueued');
    queue.backfillMessageId(terminal.threadId, terminal.userId, enqueued.entry.id, terminal.id);
    const queued = queue.getEntrySnapshot(terminal.threadId, terminal.userId, enqueued.entry.id);
    assert.equal(
      h.messageStore.initializeQueueCustody(
        terminal.id,
        createInitialCrossThreadQueuedMessageCustody(terminal.id, [queued]),
      ).kind,
      'initialized',
    );
    const seenAt = queued.createdAt + 10;
    assert.equal(queue.markProcessingById(terminal.threadId, queued.id), true);
    assert.equal(
      queue.markQueuedAwakened(terminal.threadId, terminal.userId, queued.id, 'fable5', 'terminal-child', seenAt - 1),
      true,
    );
    queue.markProcessingSeen(terminal.threadId, terminal.userId, queued.id, ['fable5'], 'terminal-child', seenAt);
    const processing = queue.getEntrySnapshot(terminal.threadId, terminal.userId, queued.id);
    const custody = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore, now: () => seenAt + 1 });
    await custody.persistEntry(processing);

    assert.equal((await gate.close(opened)).shouldBlock, true);
    assert.equal((await h.service.completeFromCoordinationTerminal(terminal.id)).outcome, 'applied');
    const settled = await custody.commitSuccessfulTargets(processing, ['fable5'], 'terminal-child', seenAt + 20, {
      fable5: {
        invocationId: 'terminal-child',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'terminal-child' },
        handledAt: seenAt + 20,
        consumption: {
          kind: 'terminal_silent',
          projectionState: 'covered_empty',
          wake: 'coordination_terminal',
        },
      },
    });
    assert.equal(settled.perMessage[0].fullyConsumed, true);
    assert.equal(h.messageStore.getById(terminal.id).deliveryStatus, 'delivered');
    assert.equal(h.messageStore.getById(terminal.id).queueCustody.status, 'terminal');
    assert.deepEqual(h.messageStore.getById(terminal.id).queueCustody.targetOutcomeByCatId.fable5, {
      invocationId: 'terminal-child',
      disposition: 'completed_with_turn',
      evidenceRef: { kind: 'invocation_lineage', invocationId: 'terminal-child' },
      handledAt: seenAt + 20,
      consumption: {
        kind: 'terminal_silent',
        projectionState: 'covered_empty',
        wake: 'coordination_terminal',
      },
    });
    assert.deepEqual(await gate.close(opened), {
      state: 'covered_active',
      shouldBlock: false,
      transitionObserved: true,
      structuredTransitionKind: 'dispatch_dispositioned',
      dispatchDisposition: 'completed',
      dispatchDispositionEventId: `dispatch-disposition:inv-1:${h.source.id}`,
      dispatchDispositionAt: 2_000,
      evidenceRefs: [`dispatch:ball:thread:thread-1`, `route:${h.source.id}:codex-sol`],
    });

    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'replayed');
    h.setLatest(false);
    assert.equal((await h.service.completeFromCoordinationTerminal(terminal.id)).outcome, 'replayed');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
  });

  test('missing terminal identity fails closed without producing a disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const terminal = appendTerminal(h, { causal: undefined });

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      /a2a_dispatch_coordination_terminal_identity_missing/,
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('a superseded source with a successor handoff remains replaced and writes no disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const terminal = appendTerminal(h);
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('opus'),
      content: '@codex-sol continue the successor coordination',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_900,
      threadId: 'thread-1',
      extra: {
        coordination: {
          id: 'coord-successor',
          phase: 'active',
          hop: 1,
          subjectRef: 'task:successor',
        },
      },
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: successor.id,
        at: 1_900,
      }),
    );
    h.setLatest(false);

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.equal(error.replacement.sourceMessageId, successor.id);
        return true;
      },
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('both-missing coordination subjects fail closed without producing a disposition', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    delete h.source.extra.coordination.subjectRef;
    const terminal = appendTerminal(h, {
      coordination: { id: COORDINATION_ID, phase: 'terminal', hop: 2 },
    });

    await assert.rejects(
      () => h.service.completeFromCoordinationTerminal(terminal.id),
      /a2a_dispatch_coordination_terminal_mismatch/,
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('foreign or mismatched coordination terminals fail closed', async () => {
    const cases = [
      (h) => appendTerminal(h, { coordination: { id: 'coord-foreign', phase: 'terminal', hop: 2 } }),
      (h) => appendTerminal(h, { coordination: { id: COORDINATION_ID, phase: 'terminal', hop: 9 } }),
      (h) => {
        const terminal = appendTerminal(h);
        terminal.threadId = 'thread-foreign';
        return terminal;
      },
      (h) => appendTerminal(h, { stream: { invocationId: 'inv-foreign', turnInvocationId: 'inv-foreign' } }),
    ];

    for (const createTerminal of cases) {
      const h = await harness();
      bindActiveCoordination(h);
      const terminal = createTerminal(h);
      await assert.rejects(
        () => h.service.completeFromCoordinationTerminal(terminal.id),
        /a2a_dispatch_coordination_terminal_mismatch/,
      );
      assert.equal(
        (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
        false,
      );
    }
  });
});
