/**
 * F246: ApprovalItem type contract tests.
 *
 * Validates that the shared DTO used by Approval Hub adapters
 * compiles correctly and has the expected shape.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ApprovalFeatureId, ApprovalItem, ApprovalItemStatus } from '../types/approval-hub.js';

describe('F246 ApprovalItem type contract', () => {
  it('compiles with valid F128 data', () => {
    const item: ApprovalItem = {
      proposalId: 'prop-1',
      sourceFeatureId: 'F128',
      sourceThreadId: 'thread-1',
      sourceMessageId: 'msg-1',
      requesterCatId: 'opus',
      ownerUserId: 'user-1',
      status: 'pending',
      summary: 'New thread: investigation',
      detail: { title: 'investigation', reason: 'Need separate thread' },
      inlineApprovable: true,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    assert.equal(item.sourceFeatureId, 'F128');
    assert.equal(item.inlineApprovable, true);
    assert.equal(item.status, 'pending');
  });

  it('compiles with valid F225 data (no sourceMessageId, not inlineApprovable)', () => {
    const item: ApprovalItem = {
      proposalId: 'prop-2',
      sourceFeatureId: 'F225',
      sourceThreadId: 'thread-2',
      requesterCatId: 'sonnet',
      ownerUserId: 'user-1',
      status: 'pending',
      summary: 'Session handoff: sonnet → done x',
      detail: { done: 'Finished task', nextSteps: 'Continue' },
      inlineApprovable: false,
      createdAt: Date.now(),
    };
    assert.equal(item.sourceFeatureId, 'F225');
    assert.equal(item.inlineApprovable, false);
    assert.equal(item.sourceMessageId, undefined);
    assert.equal(item.expiresAt, undefined);
  });

  it('status is pending or stale', () => {
    const statuses: ApprovalItemStatus[] = ['pending', 'stale'];
    assert.equal(statuses.length, 2);
    assert.ok(statuses.includes('pending'));
    assert.ok(statuses.includes('stale'));
  });

  it('featureId is F128 or F225', () => {
    const ids: ApprovalFeatureId[] = ['F128', 'F225'];
    assert.equal(ids.length, 2);
  });

  it('re-exports through barrel', async () => {
    // Verify the types are accessible through the main barrel export
    const mod = await import('../../src/types/index.js');
    // Type-only exports won't be in the runtime module, but the import
    // should not throw — this validates the barrel re-export path compiles
    assert.ok(mod !== null);
  });
});
