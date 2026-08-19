import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectPawFeelDisposition } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/projector.js';
import { PawFeelDispositionEventSchema } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/schema.js';

const DIGEST = 'a'.repeat(64);
const SIGNAL_ID = `message-1:${DIGEST}:0`;

function event(type, overrides = {}) {
  const base = {
    eventId: `event-${type}`,
    signalId: SIGNAL_ID,
    actor: type === 'discovered' ? { kind: 'automation', id: 'reconciler' } : { kind: 'cat', id: 'opus' },
    occurredAt: '2026-07-26T00:00:00.000Z',
  };
  if (type === 'discovered') {
    return {
      ...base,
      type,
      source: {
        sourceMessageId: 'message-1',
        sourceThreadId: 'thread-1',
        sourceCatId: 'codex-sol',
        markerDigest: DIGEST,
        sameDigestOrdinal: 0,
        markerIndex: 2,
      },
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
      ...overrides,
    };
  }
  return { ...base, type, ...overrides };
}

describe('F278 paw-feel event schema', () => {
  it('rejects marker body fields instead of persisting a second truth source', () => {
    const withBody = { ...event('discovered'), markerBody: '[爪感差: rg+输出太吵]' };
    assert.equal(PawFeelDispositionEventSchema.safeParse(withBody).success, false);
  });

  it('requires a lowercase sha256 digest and matching non-negative navigation fields', () => {
    const invalid = event('discovered', {
      source: {
        ...event('discovered').source,
        markerDigest: 'ABC',
        sameDigestOrdinal: -1,
        markerIndex: -1,
      },
    });
    assert.equal(PawFeelDispositionEventSchema.safeParse(invalid).success, false);
  });
});

describe('F278 paw-feel disposition projector', () => {
  it('projects the valid new → seen → route_pending → routed path', () => {
    const projection = projectPawFeelDisposition([
      event('discovered'),
      event('seen', { occurredAt: '2026-07-26T01:00:00.000Z' }),
      event('route_pending', {
        eventId: 'event-route-pending',
        occurredAt: '2026-07-26T02:00:00.000Z',
        targetThreadId: 'thread-owner',
        ownerEvidenceRef: 'message:owner-proof',
      }),
      event('routed', {
        occurredAt: '2026-07-26T03:00:00.000Z',
        targetThreadId: 'thread-owner',
        receiptRef: 'message:owner-receipt',
      }),
    ]);

    assert.equal(projection.state, 'routed');
    assert.equal(projection.sequence, 4);
    assert.equal(projection.targetThreadId, 'thread-owner');
    assert.equal(projection.lastActorCatId, 'opus');
    assert.equal(projection.outcomeRef, 'message:owner-receipt');
  });

  it('projects route rejection back to seen while preserving aging origin', () => {
    const projection = projectPawFeelDisposition([
      event('discovered'),
      event('seen'),
      event('route_pending', {
        targetThreadId: 'thread-owner',
        ownerEvidenceRef: 'message:owner-proof',
      }),
      event('route_reopened', {
        rejectionRef: 'message:rejected',
        reasonCode: 'owner_declined',
      }),
    ]);

    assert.equal(projection.state, 'seen');
    assert.equal(projection.discoveredAt, '2026-07-26T00:00:00.000Z');
    assert.equal(projection.reasonCode, 'owner_declined');
  });

  it('projects direct three-action terminal disposition with named ownership', () => {
    const duplicate = projectPawFeelDisposition([
      event('discovered'),
      event('duplicate', {
        duplicateOf: `message-2:${'b'.repeat(64)}:0`,
        ownerCatId: 'opus',
      }),
    ]);
    const noAction = projectPawFeelDisposition([
      event('discovered'),
      event('no_action', {
        reasonCode: 'not_actionable',
        ownerCatId: 'opus',
      }),
    ]);
    const fix = projectPawFeelDisposition([
      event('discovered'),
      event('fix', {
        ownerCatId: 'opus',
        taskId: 'task-1',
        leaseId: 'lease-1',
        leaseGeneration: 4,
        custodyEvidenceRef: 'action-lease:lease-1:generation:4',
      }),
    ]);

    assert.equal(duplicate.state, 'duplicate');
    assert.equal(duplicate.ownerCatId, 'opus');
    assert.equal(noAction.state, 'no_action');
    assert.equal(noAction.ownerCatId, 'opus');
    assert.equal(fix.state, 'fix');
    assert.equal(fix.ownerCatId, 'opus');
    assert.equal(fix.taskId, 'task-1');
    assert.deepEqual(fix.actionLeaseRef, { leaseId: 'lease-1', generation: 4 });
  });

  it('fails loud on missing discovery, identity mismatch and illegal transitions', () => {
    assert.throws(() => projectPawFeelDisposition([event('seen')]), /discovered/i);
    assert.throws(
      () =>
        projectPawFeelDisposition([
          event('discovered', {
            signalId: `message-1:${'b'.repeat(64)}:0`,
          }),
        ]),
      /identity/i,
    );
    assert.throws(
      () =>
        projectPawFeelDisposition([
          event('discovered'),
          event('closed', { reasonCode: 'fixed', outcomeRef: 'commit:abc' }),
        ]),
      /transition/i,
    );
  });

  it('rejects automation transitions and source-cat terminal signatures', () => {
    assert.throws(
      () =>
        projectPawFeelDisposition([
          event('discovered'),
          event('seen', { actor: { kind: 'automation', id: 'reconciler' } }),
        ]),
      /automation/i,
    );
    assert.throws(
      () =>
        projectPawFeelDisposition([
          event('discovered'),
          event('seen'),
          event('closed', {
            actor: { kind: 'cat', id: 'codex-sol' },
            reasonCode: 'fixed',
            outcomeRef: 'commit:abc',
          }),
        ]),
      /source cat/i,
    );
  });
});
