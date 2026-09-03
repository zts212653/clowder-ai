/**
 * F246 Phase I: Approval Hub provenance contract tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  ApprovalDecisionMode,
  ApprovalEnvelope,
  ApprovalItem,
  ApprovalItemStatus,
  ApprovalNavigation,
  ApprovalProducerId,
  ApprovalPublication,
} from '../types/approval-hub.js';
import {
  validateApprovalCardRef,
  validateApprovalEnvelope,
  validateApprovalNavigation,
  validateApprovalOriginRef,
  validateApprovalPublication,
} from '../types/approval-hub.js';
import {
  approvalLifecycleProjectionSchema,
  type LegacyApprovalLifecycleInput,
  normalizeApprovalLifecycleProjection,
} from '../types/approval-lifecycle.js';

describe('F246 Phase I approval provenance contract', () => {
  it('represents an anchored item with distinct origin and approval-card refs', () => {
    const navigation: ApprovalNavigation = {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'thread-origin', messageId: 'msg-origin' },
      approvalCardRef: { threadId: 'thread-card', messageId: 'msg-card' },
    };
    const item: ApprovalItem = {
      proposalId: 'prop-1',
      sourceFeatureId: 'F128',
      requesterCatId: 'opus',
      ownerUserId: 'user-1',
      status: 'pending',
      summary: 'New thread: investigation',
      detail: { title: 'investigation' },
      navigation,
      inlineApprovable: false,
      createdAt: 1,
    };

    validateApprovalNavigation(item.navigation);
    assert.equal(item.navigation.state, 'anchored');
    assert.equal(item.navigation.originRef.kind, 'message');
    assert.equal(item.navigation.approvalCardRef.messageId, 'msg-card');
  });

  it('represents honest legacy records without manufacturing an anchor', () => {
    const navigation: ApprovalNavigation = {
      state: 'legacy_unanchored',
      legacyThreadId: 'thread-legacy',
    };
    validateApprovalNavigation(navigation);
    assert.equal(navigation.state, 'legacy_unanchored');
  });

  it('rejects blank message, event, and card anchors', () => {
    assert.throws(
      () => validateApprovalOriginRef({ kind: 'message', threadId: 'thread-1', messageId: '   ' }),
      /messageId/,
    );
    assert.throws(() => validateApprovalOriginRef({ kind: 'event', anchor: '', summary: 'scheduler event' }), /anchor/);
    assert.throws(
      () => validateApprovalOriginRef({ kind: 'event', anchor: 'schedule:create:1', summary: '\n' }),
      /summary/,
    );
    assert.throws(() => validateApprovalCardRef({ threadId: 'thread-1', messageId: '' }), /messageId/);
  });

  it('rejects a runtime envelope from an unregistered producer', () => {
    const envelope = {
      canonicalProposalId: 'prop-unknown',
      sourceFeatureId: 'F999',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      originRef: { kind: 'message', threadId: 'thread-1', messageId: 'msg-origin' },
      approvalCardRef: { threadId: 'thread-1', messageId: 'msg-card' },
      createdAt: 1,
    } as unknown as ApprovalEnvelope;

    assert.throws(() => validateApprovalEnvelope(envelope), /sourceFeatureId/);
  });

  it('rejects unknown runtime discriminants instead of treating them as valid variants', () => {
    assert.throws(
      () =>
        validateApprovalOriginRef({
          kind: 'unknown',
          anchor: 'event:1',
          summary: 'event',
        } as unknown as ApprovalEnvelope['originRef']),
      /originRef.kind/,
    );
    assert.throws(
      () => validateApprovalNavigation({ state: 'unknown' } as unknown as ApprovalNavigation),
      /navigation.state/,
    );
    assert.throws(
      () => validateApprovalPublication({ state: 'unknown' } as unknown as ApprovalPublication),
      /publication.state/,
    );
  });

  it('models staged, anchored, tombstoned, and legacy publication states', () => {
    const publications: ApprovalPublication[] = [
      { state: 'staged', stagedAt: 1 },
      {
        state: 'anchored',
        envelope: {
          canonicalProposalId: 'prop-1',
          sourceFeatureId: 'F128',
          ownerUserId: 'user-1',
          requesterCatId: 'opus',
          originRef: { kind: 'message', threadId: 'thread-1', messageId: 'msg-origin' },
          approvalCardRef: { threadId: 'thread-1', messageId: 'msg-card' },
          createdAt: 1,
        },
      },
      { state: 'tombstoned', failedAt: 2, reason: 'card append failed' },
      { state: 'legacy_unanchored', legacyThreadId: 'thread-old', classifiedAt: 3 },
    ];
    assert.deepEqual(
      publications.map((publication) => publication.state),
      ['staged', 'anchored', 'tombstoned', 'legacy_unanchored'],
    );
  });

  it('keeps the admitted producer union exhaustive through F276 and excludes F028', () => {
    const ids: ApprovalProducerId[] = ['F128', 'F139', 'F193', 'F221', 'F225', 'F231', 'F260', 'F266', 'F276', 'F292'];
    assert.equal(ids.length, 10);
    assert.equal(ids.includes('F028' as ApprovalProducerId), false);
  });

  it('keeps pending/stale as Hub projection statuses', () => {
    const statuses: ApprovalItemStatus[] = ['pending', 'stale'];
    assert.deepEqual(statuses, ['pending', 'stale']);
  });

  it('admits feature-owned exact-claim selection without changing generic approval modes', () => {
    const modes: ApprovalDecisionMode[] = ['approve-reject', 'claim-select', 'meeting-intake'];
    assert.deepEqual(modes, ['approve-reject', 'claim-select', 'meeting-intake']);
  });
});

describe('canonical Approval lifecycle projection', () => {
  it.each([
    ['pending', 'open', 'not_started'],
    ['approving', 'accepted', 'outcome_unknown'],
    ['applying', 'accepted', 'outcome_unknown'],
    ['approved', 'accepted', 'outcome_unknown'],
    ['rejected', 'rejected', 'not_started'],
    ['withdrawn', 'closed_without_decision', 'not_started'],
    ['superseded', 'closed_without_decision', 'not_started'],
    ['stale', 'closed_without_decision', 'not_started'],
  ] as const)('normalizes legacy %s without leaking vocabulary', (status, resolution, materialization) => {
    assert.deepEqual(normalizeApprovalLifecycleProjection({ status }), {
      resolution,
      materialization: { state: materialization },
    });
  });

  it('requires canonical effect proof before an old approved record can claim success', () => {
    assert.deepEqual(
      normalizeApprovalLifecycleProjection({
        status: 'approved',
        canonicalEffectProofRef: 'receipt:f193:dispatch-1',
      }),
      {
        resolution: 'accepted',
        materialization: { state: 'succeeded', effectProofRef: 'receipt:f193:dispatch-1' },
      },
    );
  });

  it('rejects impossible resolution/materialization pairs', () => {
    assert.throws(
      () =>
        approvalLifecycleProjectionSchema.parse({
          resolution: 'rejected',
          materialization: { state: 'succeeded', effectProofRef: 'receipt:forbidden' },
        }),
      /accepted/i,
    );
  });

  it('fails closed on unknown legacy vocabulary', () => {
    assert.throws(
      () => normalizeApprovalLifecycleProjection({ status: 'magic_done' } as unknown as LegacyApprovalLifecycleInput),
      /unknown legacy Approval status/i,
    );
  });
});
