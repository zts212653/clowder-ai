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
        socketEmitWithAck: async (event, data, room, timeoutMs) => {
          acknowledgedCalls.push({ event, data, room, timeoutMs });
          return [];
        },
      },
      { eventId: 'evt-1', port: 5173, path: '/' },
      'user:tester',
    );

    assert.deepEqual(legacyCalls, [], 'no legacy room emission (review round-2 P1)');
    assert.deepEqual(acknowledgedCalls, [
      {
        event: 'preview:auto-open',
        data: { eventId: 'evt-1', port: 5173, path: '/' },
        room: 'user:tester',
        timeoutMs: undefined,
      },
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

  it('lets a queued/client_inactive receipt win over skipped (hidden-tab deferred delivery)', () => {
    // F120 reliability: hidden tabs now queue instead of skipping. The server
    // must recognize queued/client_inactive as actionable so cats get back
    // "queued" instead of "unconfirmed/no_matching_client".
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-deferred', [
        { status: 'queued', eventId: 'evt-deferred', reason: 'client_inactive' },
      ]),
      { deliveryStatus: 'queued', deliveryReason: 'client_inactive' },
    );
  });

  it('queued/client_inactive ranks below queued/thread_inactive in tie-breaking', () => {
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts('evt-rank', [
        { status: 'queued', eventId: 'evt-rank', reason: 'client_inactive' },
        { status: 'queued', eventId: 'evt-rank', reason: 'thread_inactive' },
      ]),
      { deliveryStatus: 'queued', deliveryReason: 'thread_inactive' },
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

  it('does not accept Store mutation as visible-page proof', () => {
    const event = {
      eventId: 'evt-visible',
      port: 3011,
      path: '/',
      targetOrigin: 'http://preview-3011.localhost:4111',
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };

    assert.deepEqual(aggregatePreviewAutoOpenReceipts(event, [{ status: 'applied', eventId: event.eventId }]), {
      deliveryStatus: 'unconfirmed',
      deliveryReason: 'visible_page_not_attested',
    });
  });

  it('returns applied only for a verified exact revision and DOM attestation', () => {
    const revision = 'b'.repeat(40);
    const targetOrigin = 'http://preview-3011.localhost:4111';
    const admission = {
      expectedClientRevision: revision,
      requiredDom: [
        {
          selector: '[data-layout-owner="f307"]',
          attributes: {
            'data-layout-hydrated': 'true',
            'data-workbench-focus': 'home',
            'data-zero-topology-contract': 'canonical-home',
          },
          textIncludes: ['你想打开什么？'],
        },
      ],
      forbiddenText: ['工作台已清空'],
    };
    const event = { eventId: 'evt-verified', port: 3011, path: '/', targetOrigin, visiblePageAdmission: admission };
    const attestation = {
      eventId: event.eventId,
      targetPort: 3011,
      targetOrigin,
      targetPath: '/',
      clientRevision: revision,
      dom: [
        {
          selector: admission.requiredDom[0].selector,
          found: true,
          attributes: {
            'data-layout-hydrated': 'true',
            'data-workbench-focus': 'home',
            'data-zero-topology-contract': 'canonical-home',
          },
          textMatches: [true],
        },
      ],
      forbiddenTextMatches: [false],
    };

    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts(event, [{ status: 'applied', eventId: event.eventId, attestation }]),
      {
        deliveryStatus: 'applied',
        visiblePageAdmission: {
          verified: true,
          targetPort: 3011,
          targetOrigin,
          targetPath: '/',
          clientRevision: revision,
        },
      },
    );
  });

  it('fails a stale revision even when the DOM happens to match', () => {
    const targetOrigin = 'http://preview-3011.localhost:4111';
    const event = {
      eventId: 'evt-stale',
      port: 3011,
      path: '/',
      targetOrigin,
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    const attestation = {
      eventId: event.eventId,
      targetPort: 3011,
      targetOrigin,
      targetPath: '/',
      clientRevision: 'a'.repeat(40),
      dom: [{ selector: '[data-layout-owner="f307"]', found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };

    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts(event, [{ status: 'applied', eventId: event.eventId, attestation }]),
      {
        deliveryStatus: 'unconfirmed',
        deliveryReason: 'visible_page_mismatch',
        visiblePageAdmission: { verified: false, mismatches: ['client_revision_mismatch'] },
      },
    );
  });

  it('fails proof from a previous path on the same port and origin', () => {
    const targetOrigin = 'http://preview-3011.localhost:4111';
    const event = {
      eventId: 'evt-path-switch',
      port: 3011,
      path: '/thread/thread-new?f307WorkbenchGate=true',
      targetOrigin,
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    const attestation = {
      eventId: event.eventId,
      targetPort: 3011,
      targetOrigin,
      targetPath: '/thread/thread-old?f307WorkbenchGate=true',
      clientRevision: 'b'.repeat(40),
      dom: [{ selector: '[data-layout-owner="f307"]', found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };

    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts(event, [{ status: 'applied', eventId: event.eventId, attestation }]),
      {
        deliveryStatus: 'unconfirmed',
        deliveryReason: 'visible_page_mismatch',
        visiblePageAdmission: { verified: false, mismatches: ['target_path_mismatch'] },
      },
    );
  });

  it('applies only when the visible page attests the requested fragment', () => {
    const targetOrigin = 'http://preview-3011.localhost:4111';
    const targetPath = '/thread/thread-f307?f307WorkbenchGate#surface-terminal';
    const event = {
      eventId: 'evt-fragment',
      port: 3011,
      path: targetPath,
      targetOrigin,
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    const attestation = {
      eventId: event.eventId,
      targetPort: 3011,
      targetOrigin,
      targetPath,
      clientRevision: 'b'.repeat(40),
      dom: [{ selector: '[data-layout-owner="f307"]', found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };

    assert.equal(
      aggregatePreviewAutoOpenReceipts(event, [{ status: 'applied', eventId: event.eventId, attestation }])
        .deliveryStatus,
      'applied',
    );

    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts(event, [
        {
          status: 'applied',
          eventId: event.eventId,
          attestation: { ...attestation, targetPath: `${targetPath}-stale` },
        },
      ]),
      {
        deliveryStatus: 'unconfirmed',
        deliveryReason: 'visible_page_mismatch',
        visiblePageAdmission: { verified: false, mismatches: ['target_path_mismatch'] },
      },
    );
  });

  it('gives the rendered iframe a bounded attestation window', async () => {
    const calls = [];
    const event = {
      eventId: 'evt-window',
      port: 3011,
      path: '/',
      targetOrigin: 'http://preview-3011.localhost:4111',
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    await emitPreviewAutoOpen(
      {
        socketEmitWithAck: async (...args) => {
          calls.push(args);
          return [];
        },
      },
      event,
      'user:tester',
    );
    assert.equal(calls[0][3], 10_000);
  });

  it('fails closed when multiple actionable visible clients disagree about custody', () => {
    const event = {
      eventId: 'evt-ambiguous',
      port: 3011,
      path: '/',
      targetOrigin: 'http://preview-3011.localhost:4111',
      visiblePageAdmission: {
        expectedClientRevision: 'b'.repeat(40),
        requiredDom: [{ selector: '[data-layout-owner="f307"]' }],
      },
    };
    const attestation = {
      eventId: event.eventId,
      targetPort: 3011,
      targetOrigin: event.targetOrigin,
      targetPath: '/',
      clientRevision: 'b'.repeat(40),
      dom: [{ selector: '[data-layout-owner="f307"]', found: true, attributes: {}, textMatches: [] }],
      forbiddenTextMatches: [],
    };
    assert.deepEqual(
      aggregatePreviewAutoOpenReceipts(event, [
        { status: 'applied', eventId: event.eventId, attestation },
        { status: 'queued', eventId: event.eventId, reason: 'thread_inactive' },
      ]),
      { deliveryStatus: 'unconfirmed', deliveryReason: 'visible_page_ambiguous_clients' },
    );
  });
});
