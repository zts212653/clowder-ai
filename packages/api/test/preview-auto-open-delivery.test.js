import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregatePreviewAutoOpenReceipts,
  emitPreviewAutoOpen,
} from '../dist/domains/preview/preview-auto-open-delivery.js';

describe('preview auto-open delivery contract', () => {
  it('emits only to the caller user room — no legacy fire-and-forget broadcast', async () => {
    const acknowledgedCalls = [];
    const legacyCalls = [];

    await emitPreviewAutoOpen(
      {
        socketEmit: (event, data, room) => {
          legacyCalls.push({ event, data, room });
        },
        socketEmitWithAck: async (event, data, room) => {
          acknowledgedCalls.push({ event, data, room });
          return [];
        },
      },
      { eventId: 'evt-1', port: 5173, path: '/' },
      'user:tester',
    );

    assert.deepEqual(legacyCalls, [], 'no legacy room emission (review round-2 P1)');
    assert.deepEqual(acknowledgedCalls, [
      { event: 'preview:auto-open', data: { eventId: 'evt-1', port: 5173, path: '/' }, room: 'user:tester' },
    ]);
  });

  it('enforces applied > blocked > queued and ignores mismatched event ids', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-priority', [
        { status: 'queued', eventId: 'evt-priority', reason: 'thread_inactive' },
        { status: 'blocked', eventId: 'evt-priority', reason: 'presentation_lock' },
        { status: 'applied', eventId: 'evt-priority' },
        { status: 'applied', eventId: 'different-event' },
      ]),
      { deliveryStatus: 'applied' },
    );
  });

  it('skipped receipts never win aggregation', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-skip', [
        { status: 'skipped', eventId: 'evt-skip', reason: 'worktree_mismatch' },
        { status: 'queued', eventId: 'evt-skip', reason: 'thread_inactive' },
      ]),
      { deliveryStatus: 'queued', deliveryReason: 'thread_inactive' },
    );
  });

  it('only-skipped answers report no_matching_client, distinct from a missing ack', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-skip-only', [
        { status: 'skipped', eventId: 'evt-skip-only', reason: 'worktree_mismatch' },
      ]),
      { deliveryStatus: 'unconfirmed', deliveryReason: 'no_matching_client' },
    );
    assert.deepEqual(aggregatePreviewAutoOpenReceipts('evt-none', []), {
      deliveryStatus: 'unconfirmed',
      deliveryReason: 'no_client_ack',
    });
  });

  it('does not let a hidden client receipt win delivery aggregation', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-hidden', [
        { status: 'skipped', eventId: 'evt-hidden', reason: 'client_inactive' },
      ]),
      { deliveryStatus: 'unconfirmed', deliveryReason: 'no_matching_client' },
    );
  });

  it('rejects unsupported receipt reasons before deterministic tie-breaking', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-reason', [
        { status: 'blocked', eventId: 'evt-reason', reason: 'spoofed_reason' },
        { status: 'blocked', eventId: 'evt-reason', reason: 'thread_inactive' },
      ]),
      { deliveryStatus: 'blocked', deliveryReason: 'thread_inactive' },
    );
  });

  it('returns unconfirmed when the emitter lacks socketEmitWithAck', async () => {
    const result = await emitPreviewAutoOpen(
      { socketEmit: () => {} },
      { eventId: 'evt-legacy', port: 5173 },
      'user:tester',
    );
    assert.deepEqual(result, { deliveryStatus: 'unconfirmed', deliveryReason: 'no_client_ack' });
  });
});
