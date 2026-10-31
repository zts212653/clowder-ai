import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateWorkspaceNavigationReceipts,
  emitWorkspaceNavigate,
} from '../dist/domains/workspace/workspace-navigation-delivery.js';

describe('workspace navigation delivery contract', () => {
  it('notifies legacy rooms while collecting truth only from the dedicated ack room', async () => {
    const acknowledgedCalls = [];
    const legacyCalls = [];

    await emitWorkspaceNavigate(
      {
        socketEmit: (event, data, room) => {
          legacyCalls.push({ event, data, room });
        },
        socketEmitWithAck: async (event, data, room) => {
          acknowledgedCalls.push({ event, data, room });
          return [];
        },
      },
      { eventId: 'event-room' },
      ['worktree:legacy-wt', 'workspace:global'],
    );

    assert.deepEqual(legacyCalls, [
      {
        event: 'workspace:navigate',
        data: { eventId: 'event-room' },
        room: 'worktree:legacy-wt',
      },
      {
        event: 'workspace:navigate',
        data: { eventId: 'event-room' },
        room: 'workspace:global',
      },
    ]);
    assert.deepEqual(acknowledgedCalls, [
      {
        event: 'workspace:navigate',
        data: { eventId: 'event-room' },
        room: 'workspace:navigate:ack',
      },
    ]);
  });

  it('enforces applied > blocked > queued and ignores mismatched event ids', () => {
    assert.deepEqual(
      aggregateWorkspaceNavigationReceipts('event-priority', [
        { status: 'queued', eventId: 'event-priority', reason: 'thread_inactive' },
        { status: 'blocked', eventId: 'event-priority', reason: 'presentation_lock' },
        { status: 'applied', eventId: 'event-priority' },
        { status: 'applied', eventId: 'different-event' },
      ]),
      { deliveryStatus: 'applied' },
    );
  });

  it('rejects unsupported receipt reasons before deterministic tie-breaking', () => {
    assert.deepEqual(
      aggregateWorkspaceNavigationReceipts('event-reason', [
        { status: 'blocked', eventId: 'event-reason', reason: 'spoofed_reason' },
        { status: 'blocked', eventId: 'event-reason', reason: 'thread_inactive' },
      ]),
      { deliveryStatus: 'blocked', deliveryReason: 'thread_inactive' },
    );
  });
});
