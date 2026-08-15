/**
 * F167 — exact ordinary A2A dispatch disposition.
 *
 * Uses the real event log/projector/service. This is the regression for
 * thread_mselq023jyelommr: an ordinary A2A turn completed real work, but the
 * dispatch ball had no invocation-bound terminal producer and a routing_guard
 * child was spawned.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { A2ADispatchDispositionService } from '../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

class MemoryEventLog {
  events = [];
  async append(event) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { outcome: 'duplicate' };
    }
    if (this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length !== expectedSequence) {
      return {
        outcome: 'conflict',
        actualSequence: this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length,
      };
    }
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();
  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

async function harness({ beforeDispositionRecord } = {}) {
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  const messageStore = new MessageStore();
  const source = messageStore.append({
    userId: 'user-1',
    catId: createCatId('fable5'),
    content: '@codex-sol review complete',
    mentions: [createCatId('codex-sol')],
    timestamp: 1_000,
    threadId: 'thread-1',
    origin: 'stream',
  });
  await ingest.record(
    buildHandedEvent({
      threadId: 'thread-1',
      fromCatId: 'fable5',
      toCatId: 'codex-sol',
      messageId: source.id,
      at: 1_000,
    }),
  );
  let latest = true;
  const fencedIngest = beforeDispositionRecord
    ? {
        record: (event) => ingest.record(event),
        async recordFenced(event, expectedSequence) {
          if (event.kind === 'ball.dispatch_dispositioned') {
            await beforeDispositionRecord({ event, ingest });
          }
          return ingest.recordFenced(event, expectedSequence);
        },
      }
    : ingest;
  const service = new A2ADispatchDispositionService({
    registry: { isLatest: async (invocationId) => latest && invocationId === 'inv-1' },
    messageStore,
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: fencedIngest,
    repairProjection: (subjectKey) => projector.rebuild(subjectKey),
    now: () => 2_000,
  });
  return {
    eventLog,
    projectionStore,
    ingest,
    messageStore,
    source,
    service,
    setLatest(value) {
      latest = value;
    },
  };
}

function auth(h, overrides = {}) {
  return {
    invocationId: 'inv-1',
    callbackToken: 'token',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    catId: createCatId('codex-sol'),
    threadId: 'thread-1',
    a2aTriggerMessageId: h.source.id,
    originTriggerMessageId: h.source.id,
    clientMessageIds: new Set(),
    createdAt: 1,
    expiresAt: 99_000,
    ...overrides,
  };
}

function dispatchWake(h) {
  return {
    kind: 'structured',
    protocol: 'dispatch',
    subjectKey: 'ball:thread:thread-1',
    holderCatId: 'codex-sol',
    handoff: {
      sourceEventId: `route:${h.source.id}:codex-sol`,
      messageId: h.source.id,
      fromCatId: 'fable5',
    },
  };
}

describe('F167 ordinary A2A dispatch disposition', () => {
  test('only the exact invocation-bound producer terminalizes the dispatch ball once', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));

    assert.equal((await gate.close(opened)).shouldBlock, true);
    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
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
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
  });

  test('handled remains distinguishable from completed at the stop-gate decision boundary', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));

    await h.service.complete(auth(h), 'handled');

    assert.deepEqual(await gate.close(opened), {
      state: 'covered_active',
      shouldBlock: false,
      transitionObserved: true,
      structuredTransitionKind: 'dispatch_dispositioned',
      dispatchDisposition: 'handled',
      dispatchDispositionEventId: `dispatch-disposition:inv-1:${h.source.id}`,
      dispatchDispositionAt: 2_000,
      evidenceRefs: [`dispatch:ball:thread:thread-1`, `route:${h.source.id}:codex-sol`],
    });
  });

  test('concurrent conflicting dispositions linearize to one event and reject the loser', async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.service.complete(auth(h), 'handled'),
      h.service.complete(auth(h), 'completed'),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.dispatch_dispositioned')
        .length,
      1,
    );
  });

  test('a stale disposition cannot resolve a successor holder after the holder check', async () => {
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        await ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'successor-message',
            at: 1_500,
          }),
        );
      },
    });

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      /^A2ADispatchDispositionError: a2a_dispatch_disposition_fence_conflict$/,
    );
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.state, 'active');
    assert.equal(projection.holder, 'opus');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
      false,
    );
  });

  test('wrong source/invocation/thread/holder/from-cat plus stale and replaced calls fail closed', async () => {
    const mutations = [
      (h) => auth(h, { a2aTriggerMessageId: 'other-message', originTriggerMessageId: 'other-message' }),
      (h) => auth(h, { invocationId: 'other-invocation' }),
      (h) => auth(h, { threadId: 'other-thread' }),
      (h) => auth(h, { catId: createCatId('opus') }),
      (h) => {
        h.source.catId = createCatId('codex-sol');
        return auth(h);
      },
      (h) => {
        h.setLatest(false);
        return auth(h);
      },
      async (h) => {
        await h.ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'replacement-message',
            at: 1_500,
          }),
        );
        return auth(h);
      },
    ];

    for (const mutate of mutations) {
      const h = await harness();
      const attempt = await mutate(h);
      await assert.rejects(() => h.service.complete(attempt, 'handled'), /a2a_dispatch_disposition_/);
      assert.equal(
        (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.dispatch_dispositioned'),
        false,
      );
    }
  });

  test('unrelated task, command, merge, and another coordination terminal never close this dispatch', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));
    for (const event of [
      {
        sourceEventId: 'task:other:done',
        subjectKey: 'ball:thread:thread-1',
        kind: 'task.done',
        classification: 'state-changing',
        payload: { taskId: 'other' },
        at: 1_100,
      },
      {
        sourceEventId: 'route:coord-terminal',
        subjectKey: 'ball:thread:thread-1',
        kind: 'ball.handed_cvo',
        classification: 'state-changing',
        payload: { fromCatId: 'fable5', intent: 'done_notify' },
        at: 1_200,
      },
    ]) {
      await h.eventLog.append(event);
    }
    assert.equal((await gate.close(opened)).shouldBlock, true);
  });
});
