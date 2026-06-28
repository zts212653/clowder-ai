/**
 * F233 PR3 — invocation lifecycle source events.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F233 PR3: invocation ball-custody events', () => {
  test('reconcileZombies records invocation.died after running record is marked failed', async () => {
    const { reconcileZombies } = await import('../dist/domains/cats/services/agents/invocation/reconcileZombies.js');
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    const store = new InvocationRecordStore();
    const created = store.create({
      threadId: 'thr-dead',
      userId: 'user-dead',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: 'dead-key',
    });
    store.update(created.invocationId, { status: 'running' });

    const events = [];
    const zombie = {
      invocationId: created.invocationId,
      catId: 'codex',
      recordStatus: 'running',
      recordUpdatedAt: 123_456,
      reason: 'no_tracker_no_fresh_draft_age_exceeded',
    };

    const result = await reconcileZombies([zombie], {
      invocationRecordStore: store,
      ballCustody: {
        async record(event) {
          events.push(event);
        },
      },
      log: { info() {}, warn() {} },
    });

    assert.equal(result.reconciled, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'invocation.died');
    assert.equal(events[0].sourceEventId, `inv:${created.invocationId}:died`);
    assert.equal(events[0].subjectKey, 'ball:thread:thr-dead');
    assert.deepEqual(events[0].payload, {
      invocationId: created.invocationId,
      catId: 'codex',
      reason: 'no_tracker_no_fresh_draft_age_exceeded',
      lastScanAt: 123_456,
    });
  });
});
