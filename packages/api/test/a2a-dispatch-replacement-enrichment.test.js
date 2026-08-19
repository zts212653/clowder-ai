import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCatId } from '@cat-cafe/shared';
import { buildHandedCvoEvent, buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

function throwForSuccessor(messageStore, successorId, failure) {
  const getById = messageStore.getById.bind(messageStore);
  messageStore.getById = async (messageId) => {
    if (messageId === successorId) throw new Error(failure);
    return getById(messageId);
  };
}

describe('F167 A2A replacement metadata enrichment', () => {
  test('handed replacement verdict survives optional successor metadata lookup failure', async () => {
    const h = await harness();
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('opus'),
      content: '@codex-sol continue despite unavailable enrichment',
      mentions: [createCatId('codex-sol')],
      timestamp: 1_500,
      threadId: 'thread-1',
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
    throwForSuccessor(h.messageStore, successor.id, 'successor metadata unavailable');

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.deepEqual(error.replacement, {
          kind: 'handed',
          sourceEventId: `route:${successor.id}:codex-sol`,
          fromCatId: 'opus',
          toCatId: 'codex-sol',
        });
        return true;
      },
    );
  });

  test('handed-to-operator replacement verdict survives optional successor metadata lookup failure', async () => {
    const h = await harness();
    const successor = h.messageStore.append({
      userId: 'user-1',
      catId: createCatId('codex-sol'),
      content: '@co-creator successor coordination',
      mentions: [],
      timestamp: 1_500,
      threadId: 'thread-1',
    });
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'codex-sol',
        messageId: successor.id,
        intent: 'handoff',
        at: 1_500,
      }),
    );
    throwForSuccessor(h.messageStore, successor.id, 'operator successor metadata unavailable');

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      (error) => {
        assert.equal(error.code, 'a2a_dispatch_disposition_replaced');
        assert.deepEqual(error.replacement, {
          kind: 'handed_cvo',
          sourceEventId: `route:${successor.id}`,
          fromCatId: 'codex-sol',
          intent: 'handoff',
        });
        return true;
      },
    );
  });
});
