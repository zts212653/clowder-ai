/**
 * F246 Phase B: DispatchProposal type contract tests.
 *
 * Validates that the new types (EffectClass, DispatchProposal,
 * DispatchProposalStatus) compile correctly and that ApprovalFeatureId
 * includes 'F193'.
 */

import { describe, expect, it } from 'vitest';
import type { ApprovalFeatureId, ApprovalItem } from '../types/approval-hub.js';
import type { DispatchProposal, DispatchProposalStatus, EffectClass } from '../types/dispatch-proposal.js';

describe('F246 Phase B: DispatchProposal type contract', () => {
  it('EffectClass covers all four effect-classes', () => {
    const classes: EffectClass[] = ['fyi', 'coordinate', 'investigate', 'assign_work'];
    expect(classes).toHaveLength(4);
    expect(classes).toContain('fyi');
    expect(classes).toContain('assign_work');
  });

  it('DispatchProposalStatus covers three states', () => {
    const statuses: DispatchProposalStatus[] = ['pending', 'approved', 'rejected'];
    expect(statuses).toHaveLength(3);
  });

  it('DispatchProposal compiles with valid assign_work data', () => {
    const proposal: DispatchProposal = {
      proposalId: 'dp-001',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      effectClass: 'assign_work',
      content: 'Fix the bug in package X',
      targetCats: ['sonnet'],
      status: 'pending',
      createdAt: Date.now(),
    };
    expect(proposal.effectClass).toBe('assign_work');
    expect(proposal.status).toBe('pending');
    expect(proposal.targetCats).toHaveLength(1);
    expect(proposal.deliveredMessageId).toBeUndefined();
  });

  it('DispatchProposal accepts optional fields', () => {
    const proposal: DispatchProposal = {
      proposalId: 'dp-002',
      sourceThreadId: 'thread-sender',
      targetThreadId: 'thread-target',
      senderCatId: 'codex',
      ownerUserId: 'user-1',
      effectClass: 'assign_work',
      content: 'Implement feature Y',
      targetCats: ['opus', 'sonnet'],
      replyTo: 'msg-parent',
      clientMessageId: 'client-idempotent-key',
      status: 'approved',
      deliveredMessageId: 'msg-delivered-123',
      cardMessageId: 'msg-card-456',
      createdAt: Date.now() - 3600000,
      decidedAt: Date.now(),
      decidedBy: 'user-1',
    };
    expect(proposal.status).toBe('approved');
    expect(proposal.deliveredMessageId).toBe('msg-delivered-123');
    expect(proposal.decidedBy).toBe('user-1');
  });

  it('ApprovalFeatureId includes F193', () => {
    const ids: ApprovalFeatureId[] = ['F128', 'F225', 'F193'];
    expect(ids).toHaveLength(3);
    expect(ids).toContain('F193');
  });

  it('ApprovalItem compiles with F193 sourceFeatureId', () => {
    const item: ApprovalItem = {
      proposalId: 'dp-001',
      sourceFeatureId: 'F193',
      sourceThreadId: 'thread-sender',
      requesterCatId: 'opus',
      ownerUserId: 'user-1',
      status: 'pending',
      summary: 'Work assignment: Fix the bug in package X',
      detail: {
        targetThreadId: 'thread-target',
        targetCats: ['sonnet'],
        content: 'Fix the bug in package X',
        effectClass: 'assign_work',
      },
      inlineApprovable: true,
      expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    expect(item.sourceFeatureId).toBe('F193');
    expect(item.inlineApprovable).toBe(true);
  });

  it('re-exports through barrel', async () => {
    const mod = await import('../types/index.js');
    expect(mod).toBeTruthy();
    // Types are compile-time only (type-only exports) — barrel import succeeds = types compile
  });
});
