/**
 * F167 PR-A — a fail-closed dispatch disposition error says which branch it fell on.
 *
 * `a2a_dispatch_disposition_replay_mismatch` used to be a bare code. Two different situations raise it, and the
 * caller could not tell them apart:
 *   - an authoritative terminal already exists for this exact invocation and source, with a different
 *     disposition (the shape seen on 895 / 971: a consumed terminal coordination message had already recorded
 *     `completed`, then the same invocation reported `handled`);
 *   - nothing could be read back after the write.
 * The first now carries the stored terminal (disposition, invocationId, at, and whether it came from a direct
 * completion or from `completeFromCoordinationTerminal`) and a message saying the source is already terminal and
 * need not be retried. The guard itself is unchanged: the mismatch still fails closed and nothing is rewritten.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { buildDispatchDispositionEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

const REPLAY_MISMATCH = 'a2a_dispatch_disposition_replay_mismatch';

function bindActiveCoordination(h) {
  h.source.extra = {
    crossPost: { sourceThreadId: 'thread-origin', sourceInvocationId: 'origin-invocation' },
    coordination: { id: 'coord-branches', phase: 'active', hop: 1, subjectRef: 'task:branches' },
    targetCats: ['codex-sol'],
  };
}

function appendTerminal(h) {
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
      crossPost: { sourceThreadId: 'thread-1', sourceInvocationId: 'inv-1' },
      coordination: { id: 'coord-branches', phase: 'terminal', hop: 2, subjectRef: 'task:branches' },
      causal: { kind: 'invocation_reply', triggerMessageId: h.source.id },
      stream: { invocationId: 'inv-1', turnInvocationId: 'inv-1' },
      targetCats: ['fable5'],
    },
  });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return assert.fail('expected the completion to be rejected');
}

describe('F167 dispatch disposition replay_mismatch names the stored terminal', () => {
  test('a consumed coordination terminal recorded `completed`; reporting `handled` now says so (the 895 / 971 shape)', async () => {
    const h = await harness();
    bindActiveCoordination(h);
    const terminal = appendTerminal(h);
    assert.equal((await h.service.completeFromCoordinationTerminal(terminal.id)).outcome, 'applied');

    const error = await rejection(h.service.complete(auth(h), 'handled'));

    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'existing_terminal');
    assert.deepEqual(error.existingTerminal, {
      disposition: 'completed',
      invocationId: 'inv-1',
      at: 2_000,
      source: 'coordination_terminal',
    });
    // The guard did not move: nothing was appended or rewritten by the refused call.
    const events = (await h.eventLog.read('ball:thread:thread-1')).filter(
      (event) => event.kind === 'ball.dispatch_dispositioned',
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.disposition, 'completed');
    // Control: the SAME disposition is still the idempotent replay.
    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'replayed');
  });

  test('a direct completion is named as direct', async () => {
    const h = await harness();
    assert.equal((await h.service.complete(auth(h), 'handled')).outcome, 'applied');

    const error = await rejection(h.service.complete(auth(h), 'completed'));

    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'existing_terminal');
    assert.deepEqual(error.existingTerminal, {
      disposition: 'handled',
      invocationId: 'inv-1',
      at: 2_000,
      source: 'direct',
    });
  });

  test('a terminal written before provenance existed is reported as unknown, not guessed', async () => {
    const h = await harness();
    // The shape every event had before this change: no provenance field at all.
    await h.service.deps.ballCustody.record(
      buildDispatchDispositionEvent({
        threadId: 'thread-1',
        catId: 'codex-sol',
        fromCatId: 'fable5',
        invocationId: 'inv-1',
        sourceMessageId: h.source.id,
        disposition: 'completed',
        at: 1_900,
      }),
    );

    const error = await rejection(h.service.complete(auth(h), 'handled'));

    assert.equal(error.code, REPLAY_MISMATCH);
    assert.deepEqual(error.existingTerminal, {
      disposition: 'completed',
      invocationId: 'inv-1',
      at: 1_900,
      source: 'unknown',
    });
  });

  test('nothing readable after the write is a DIFFERENT branch and does not claim an existing terminal', async () => {
    const h = await harness();
    let written = false;
    const append = h.eventLog.appendFenced.bind(h.eventLog);
    h.eventLog.appendFenced = async (event, expected) => {
      const result = await append(event, expected);
      if (event.kind === 'ball.dispatch_dispositioned') written = true;
      return result;
    };
    const read = h.eventLog.read.bind(h.eventLog);
    h.eventLog.read = async (subjectKey, from) =>
      (await read(subjectKey, from)).filter((event) => !(written && event.kind === 'ball.dispatch_dispositioned'));

    const error = await rejection(h.service.complete(auth(h), 'handled'));

    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'read_back_missing');
    assert.equal(error.existingTerminal, undefined, 'there is no stored terminal to report');
  });
});
