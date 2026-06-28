/**
 * F167 Phase O PR-O2b: Claim Extractor Tests
 *
 * Tests claim extraction from hold_ball, register_pr_tracking,
 * and register_issue_tracking call contexts.
 *
 * TDD: RED phase — these tests define expected behavior before implementation.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { extractPrTrackingClaims, extractIssueTrackingClaims, extractHoldBallClaims } = await import(
  '../dist/infrastructure/grounding/claim-extractors.js'
);

// ── register_pr_tracking ─────────────────────────────────────

describe('extractPrTrackingClaims', () => {
  test('extracts object claim with PR sourceRef', () => {
    const claims = extractPrTrackingClaims({
      repoFullName: 'AgeOfLearning/cat-cafe',
      prNumber: 2435,
    });
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.claimType, 'object');
    assert.equal(claim.sourceKind, 'self');
    assert.deepEqual(claim.sourceRef, {
      kind: 'pr_url',
      value: 'AgeOfLearning/cat-cafe#2435',
    });
    assert.ok(claim.claimSummary?.includes('2435'));
  });

  test('sourceRef value follows repo#number format', () => {
    const claims = extractPrTrackingClaims({
      repoFullName: 'org/repo',
      prNumber: 99,
    });
    assert.equal(claims[0].sourceRef.value, 'org/repo#99');
  });
});

// ── register_issue_tracking ──────────────────────────────────

describe('extractIssueTrackingClaims', () => {
  test('extracts object claim with issue sourceRef', () => {
    const claims = extractIssueTrackingClaims({
      repoFullName: 'AgeOfLearning/cat-cafe',
      issueNumber: 150,
    });
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.claimType, 'object');
    assert.equal(claim.sourceKind, 'self');
    assert.deepEqual(claim.sourceRef, {
      kind: 'issue_id',
      value: 'AgeOfLearning/cat-cafe#150',
    });
    assert.ok(claim.claimSummary?.includes('150'));
  });
});

// ── hold_ball ────────────────────────────────────────────────

describe('extractHoldBallClaims', () => {
  test('with waitSourceRef: extracts wait claim with structured sourceRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for reporter to provide repro steps',
      waitSourceRef: {
        kind: 'github_issue',
        value: 'AgeOfLearning/cat-cafe#200',
        expectedSignal: 'reporter adds comment with repro',
        slaUntilMs: 3_600_000,
      },
    });
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.claimType, 'wait');
    assert.equal(claim.sourceKind, 'self');
    assert.equal(claim.sourceRef.kind, 'issue_id');
    assert.equal(claim.sourceRef.value, 'AgeOfLearning/cat-cafe#200');
    assert.ok(claim.waitSourceRef);
    assert.equal(claim.waitSourceRef.kind, 'github_issue');
    assert.equal(claim.waitSourceRef.slaUntilMs, 3_600_000);
  });

  test('with waitSourceRef kind=thread_message: maps to messageId sourceRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for operator response',
      waitSourceRef: {
        kind: 'thread_message',
        value: 'msg_abc123',
        expectedSignal: 'operator reply',
        slaUntilMs: 1_800_000,
      },
    });
    assert.equal(claims[0].sourceRef.kind, 'messageId');
    assert.equal(claims[0].sourceRef.value, 'msg_abc123');
  });

  test('with waitSourceRef kind=task: maps to task_id sourceRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for scheduled task completion',
      waitSourceRef: {
        kind: 'task',
        value: 'dyn-task-42',
        expectedSignal: 'task fires',
        slaUntilMs: 900_000,
      },
    });
    assert.equal(claims[0].sourceRef.kind, 'task_id');
    assert.equal(claims[0].sourceRef.value, 'dyn-task-42');
  });

  test('with waitSourceRef kind=github_comment: maps to issue_id sourceRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for issue comment update',
      waitSourceRef: {
        kind: 'github_comment',
        value: 'AgeOfLearning/cat-cafe#200/comment/42',
        expectedSignal: 'comment update',
        slaUntilMs: 600_000,
      },
    });
    assert.equal(claims[0].sourceRef.kind, 'issue_id');
    assert.equal(claims[0].sourceRef.value, 'AgeOfLearning/cat-cafe#200/comment/42');
  });

  test('with waitSourceRef kind=reporter_handle: maps to messageId with anchorRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for reporter clarification',
      waitSourceRef: {
        kind: 'reporter_handle',
        value: 'user123',
        anchorRef: 'msg_anchor_456',
        expectedSignal: 'reporter replies',
        slaUntilMs: 1_200_000,
      },
    });
    assert.equal(claims[0].sourceRef.kind, 'messageId');
    assert.equal(claims[0].sourceRef.value, 'msg_anchor_456');
  });

  test('with waitSourceRef kind=pending_input: maps to messageId with anchorRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for user input on design question',
      waitSourceRef: {
        kind: 'pending_input',
        value: 'design_choice_q1',
        anchorRef: 'msg_design_789',
        expectedSignal: 'user picks option',
        slaUntilMs: 900_000,
      },
    });
    assert.equal(claims[0].sourceRef.kind, 'messageId');
    assert.equal(claims[0].sourceRef.value, 'msg_design_789');
  });

  test('without waitSourceRef: extracts wait claim with unstructured sentinel sourceRef', () => {
    const claims = extractHoldBallClaims({
      reason: 'Waiting for cloud codex review result',
    });
    assert.equal(claims.length, 1);
    const [claim] = claims;
    assert.equal(claim.claimType, 'wait');
    assert.equal(claim.sourceKind, 'self');
    assert.deepEqual(claim.sourceRef, { kind: 'messageId', value: 'unstructured-wait' });
    assert.ok(claim.claimSummary?.includes('cloud codex review'));
    assert.equal(claim.waitSourceRef, undefined);
  });

  test('claimSummary truncated to 200 chars', () => {
    const longReason = 'A'.repeat(300);
    const claims = extractHoldBallClaims({ reason: longReason });
    assert.ok((claims[0].claimSummary?.length ?? 0) <= 200);
  });
});
