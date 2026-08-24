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
import { buildHandedEvent, buildHeldEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionWake as dispatchWake,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

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

  test('terminalizes the exact dispatch without stealing an unrelated cat hold', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open(dispatchWake(h));
    await h.ingest.record(
      buildHeldEvent({
        threadId: 'thread-1',
        catId: 'opus',
        fireAt: 99_000,
        at: 1_500,
      }),
    );

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, true, 'the exact child terminal is inert on the unrelated subject holder');
    const disposition = (await h.eventLog.read('ball:thread:thread-1')).find(
      (event) => event.kind === 'ball.dispatch_dispositioned',
    );
    assert.equal(disposition.payload.retired, true);
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.state, 'active');
    assert.equal(projection.holder, 'opus');
    assert.equal(projection.heldUntil, 99_000);
    assert.equal(projection.lastEventAt, 2_000);
    assert.equal((await gate.close(opened)).shouldBlock, false, 'the exact dispatch stop gate observes its terminal');
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

  test('replaced dispositions identify the latest verified successor coordination', async () => {
    const h = await harness();
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('opus'),
      content: '@codex-sol continue the replacement coordination',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_500,
      threadId: 'thread-1',
      extra: {
        coordination: {
          id: 'coord-successor',
          phase: 'active',
          hop: 1,
          subjectRef: 'pr:zts212653/cat-cafe#3710',
        },
      },
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: successor.id,
        at: 1_500,
      }),
    );

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.deepEqual(error.replacement, {
          kind: 'handed',
          sourceEventId: `route:${successor.id}:codex-sol`,
          sourceMessageId: successor.id,
          fromCatId: 'opus',
          toCatId: 'codex-sol',
          coordination: {
            id: 'coord-successor',
            phase: 'active',
            hop: 1,
            subjectRef: 'pr:zts212653/cat-cafe#3710',
          },
        });
        return true;
      },
    );
  });

  test('replacement metadata never crosses the disposition thread boundary', async () => {
    const h = await harness();
    const foreign = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('opus'),
      content: '@codex-sol forged successor coordinates',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_500,
      threadId: 'other-thread',
      extra: {
        coordination: { id: 'coord-foreign', phase: 'active', hop: 1 },
      },
    });
    await h.eventLog.append(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: foreign.id,
        at: 1_500,
      }),
    );

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.deepEqual(error.replacement, {
          kind: 'handed',
          sourceEventId: `route:${foreign.id}:codex-sol`,
          fromCatId: 'opus',
          toCatId: 'codex-sol',
        });
        return true;
      },
    );
  });

  test('reports the successor even when replacement handed custody away from the caller', async () => {
    const h = await harness();
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('codex-sol'),
      content: '@opus take the successor',
      mentions: [createCatId('opus')],
      timestamp: 1_500,
      threadId: 'thread-1',
      extra: { coordination: { id: 'coord-outbound', phase: 'active', hop: 2 } },
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'codex-sol',
        toCatId: 'opus',
        messageId: successor.id,
        at: 1_500,
      }),
    );

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.equal(error.replacement.sourceMessageId, successor.id);
        assert.equal(error.replacement.coordination.id, 'coord-outbound');
        assert.equal(error.replacement.toCatId, 'opus');
        return true;
      },
    );
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
