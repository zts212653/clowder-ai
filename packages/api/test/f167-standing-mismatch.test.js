/**
 * F167 × F322 — Suite 1: Pure function tests for `actionSuccessorStandingMismatchDimensions`.
 *
 * Tests the delegate-aware mismatch detection in isolation (no resolver, no admission service).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  APPROVED_DELEGATE,
  CHILD_CAT,
  CHILD_THREAD,
  holderSnapshot,
  ownerFreshness,
} from './f167-delegate-test-helpers.js';

const { actionSuccessorStandingMismatchDimensions } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);

describe('F167 approved-child standing delegation — mismatch function', () => {
  test('exact owner match produces zero mismatches (baseline)', () => {
    const dims = actionSuccessorStandingMismatchDimensions(holderSnapshot(), ownerFreshness());
    assert.deepEqual(dims, []);
  });

  test('unapproved child produces owner + target_thread mismatches', () => {
    const dims = actionSuccessorStandingMismatchDimensions(
      holderSnapshot({ holderCatIds: [CHILD_CAT], targetThreadId: CHILD_THREAD }),
      ownerFreshness(),
    );
    assert.ok(dims.includes('owner'), 'expected owner mismatch');
    assert.ok(dims.includes('target_thread'), 'expected target_thread mismatch');
  });

  test('approved child in approvedDelegates produces zero mismatches', () => {
    const dims = actionSuccessorStandingMismatchDimensions(
      holderSnapshot({ holderCatIds: [CHILD_CAT], targetThreadId: CHILD_THREAD }),
      ownerFreshness({ approvedDelegates: [APPROVED_DELEGATE] }),
    );
    assert.deepEqual(dims, [], 'approved delegate should suppress owner + target_thread');
  });

  test('approved child with wrong tenant still produces tenant mismatch', () => {
    const dims = actionSuccessorStandingMismatchDimensions(
      holderSnapshot({ holderCatIds: [CHILD_CAT], targetThreadId: CHILD_THREAD, tenantScope: 'user-wrong' }),
      ownerFreshness({ approvedDelegates: [APPROVED_DELEGATE] }),
    );
    assert.ok(dims.includes('tenant'), 'tenant is never relaxed by delegation');
    assert.ok(!dims.includes('owner'), 'owner should be suppressed by delegate');
  });

  test('delegate catId with non-delegate threadId still fails', () => {
    const dims = actionSuccessorStandingMismatchDimensions(
      holderSnapshot({ holderCatIds: [CHILD_CAT], targetThreadId: 'thread-unrelated' }),
      ownerFreshness({ approvedDelegates: [APPROVED_DELEGATE] }),
    );
    assert.ok(dims.includes('owner'), 'catId match alone is not enough — threadId must also match');
    assert.ok(dims.includes('target_thread'), 'non-matching threadId produces target_thread mismatch');
  });

  test('non-delegate cat is rejected even when approvedDelegates is populated', () => {
    const dims = actionSuccessorStandingMismatchDimensions(
      holderSnapshot({ holderCatIds: ['cat-hacker'], targetThreadId: 'thread-hacker' }),
      ownerFreshness({ approvedDelegates: [APPROVED_DELEGATE] }),
    );
    assert.ok(dims.includes('owner'), 'non-delegate cat must fail');
    assert.ok(dims.includes('target_thread'), 'non-delegate thread must fail');
  });
});
