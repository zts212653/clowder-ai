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
  test('unreadable successor metadata cannot manufacture a handed replacement verdict', async () => {
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

    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
  });

  test('unreadable successor metadata cannot manufacture a handed-to-operator replacement verdict', async () => {
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

    const result = await h.service.complete(auth(h), 'completed');
    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, true);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'parked');
  });
});
