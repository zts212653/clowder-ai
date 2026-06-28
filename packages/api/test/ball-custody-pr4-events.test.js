/**
 * F233 PR4 — remaining event builders.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F233 PR4: ball.wake_sent event builder', () => {
  it('builds sourceEventId from taskId + blockedSinceAt + at', async () => {
    const { buildWakeSentEvent } = await import('../dist/domains/ball-custody/ball-custody-events.js');

    const event = buildWakeSentEvent({
      taskId: 'task-123',
      threadId: 'thread-1',
      ownerCatId: 'codex',
      blockedSinceAt: 1_700_000_000_000,
      at: 1_700_000_100_000,
    });

    assert.equal(event.kind, 'ball.wake_sent');
    assert.equal(event.classification, 'informational');
    assert.equal(event.sourceEventId, 'wake:task-123:1700000000000:1700000100000');
    assert.equal(event.subjectKey, 'ball:task:task-123');
    assert.deepEqual(event.payload, {
      taskId: 'task-123',
      threadId: 'thread-1',
      ownerCatId: 'codex',
      blockedSinceAt: 1_700_000_000_000,
    });
  });
});
