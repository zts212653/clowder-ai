import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildA1WorldTruthSignal,
  buildMagicWordSignal,
  buildPermissionCancelSignal,
  buildProposalRejectSignal,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-signal-builder.js';

describe('Task Outcome Signal Builders (F192 Phase G)', () => {
  describe('buildPermissionCancelSignal', () => {
    it('builds a valid permission cancel signal from authorization deny', () => {
      const signal = buildPermissionCancelSignal({
        toolName: 'cat_cafe_hold_ball',
        paramsSummary: 'reason: "waiting for cloud review"',
        reason: 'wrong_direction',
        catId: 'opus',
        threadId: 'thread_abc123',
        sessionId: 'session_xyz',
      });
      assert.equal(signal.type, 'permission_cancel');
      assert.equal(signal.toolName, 'cat_cafe_hold_ball');
      assert.equal(signal.reason, 'wrong_direction');
      assert.equal(signal.catId, 'opus');
      assert.ok(signal.timestamp); // auto-generated ISO timestamp
    });

    it('defaults reason to skip when not provided', () => {
      const signal = buildPermissionCancelSignal({
        toolName: 'cat_cafe_post_message',
        catId: 'codex',
        threadId: 'thread_def',
      });
      assert.equal(signal.reason, 'skip');
      assert.equal(signal.paramsSummary, undefined);
    });

    it('truncates paramsSummary to 200 chars', () => {
      const longParams = 'x'.repeat(300);
      const signal = buildPermissionCancelSignal({
        toolName: 'edit_file',
        paramsSummary: longParams,
        catId: 'opus',
        threadId: 'thread_abc',
      });
      assert.ok(signal.paramsSummary);
      assert.ok(signal.paramsSummary.length <= 203); // 200 + '...'
    });
  });

  describe('buildMagicWordSignal', () => {
    it('builds a valid magic word signal', () => {
      const signal = buildMagicWordSignal({
        word: '脚手架',
        catId: 'opus',
        threadId: 'thread_abc123',
        precedingMessageSummary: 'Cat was writing temp fix',
        followingMessageSummary: 'operator told cat to rethink',
      });
      assert.equal(signal.type, 'magic_word');
      assert.equal(signal.word, '脚手架');
      assert.ok(signal.timestamp);
    });

    it('works without optional summaries', () => {
      const signal = buildMagicWordSignal({
        word: '绕路了',
        catId: 'codex',
        threadId: 'thread_xyz',
      });
      assert.equal(signal.word, '绕路了');
      assert.equal(signal.precedingMessageSummary, undefined);
    });

    it('truncates summaries to 200 chars', () => {
      const longSummary = 'y'.repeat(300);
      const signal = buildMagicWordSignal({
        word: '脚手架',
        catId: 'opus',
        threadId: 'thread_abc',
        precedingMessageSummary: longSummary,
      });
      assert.ok(signal.precedingMessageSummary);
      assert.ok(signal.precedingMessageSummary.length <= 203);
    });
  });

  describe('buildProposalRejectSignal', () => {
    it('builds a valid proposal reject signal for thread proposal (F128)', () => {
      const signal = buildProposalRejectSignal({
        proposalId: 'prop_abc123',
        proposalType: 'thread',
        catId: 'opus',
        threadId: 'thread_xyz',
        proposalTitle: 'Investigate F192 cancel signal gap',
        rejectionReason: 'Already handled in current thread',
      });
      assert.equal(signal.type, 'proposal_reject');
      assert.equal(signal.proposalId, 'prop_abc123');
      assert.equal(signal.proposalType, 'thread');
      assert.equal(signal.catId, 'opus');
      assert.equal(signal.threadId, 'thread_xyz');
      assert.equal(signal.proposalTitle, 'Investigate F192 cancel signal gap');
      assert.equal(signal.rejectionReason, 'Already handled in current thread');
      assert.ok(signal.timestamp);
    });

    it('builds a valid proposal reject signal for session handoff (F225)', () => {
      const signal = buildProposalRejectSignal({
        proposalId: 'handoff_def456',
        proposalType: 'session_handoff',
        catId: 'codex',
        threadId: 'thread_abc',
      });
      assert.equal(signal.type, 'proposal_reject');
      assert.equal(signal.proposalType, 'session_handoff');
      assert.equal(signal.proposalTitle, undefined);
      assert.equal(signal.rejectionReason, undefined);
    });

    it('truncates proposalTitle and rejectionReason to 200 chars', () => {
      const longTitle = 'T'.repeat(300);
      const longReason = 'R'.repeat(300);
      const signal = buildProposalRejectSignal({
        proposalId: 'prop_trunc',
        proposalType: 'thread',
        catId: 'opus',
        threadId: 'thread_trunc',
        proposalTitle: longTitle,
        rejectionReason: longReason,
      });
      assert.ok(signal.proposalTitle);
      assert.ok(signal.proposalTitle.length <= 203); // 200 + '...'
      assert.ok(signal.rejectionReason);
      assert.ok(signal.rejectionReason.length <= 203);
    });
  });

  describe('buildA1WorldTruthSignal', () => {
    it('builds a valid merge signal', () => {
      const signal = buildA1WorldTruthSignal({
        type: 'merge',
        ref: 'PR#2073',
        outcome: 'success',
      });
      assert.equal(signal.type, 'merge');
      assert.equal(signal.ref, 'PR#2073');
      assert.equal(signal.outcome, 'success');
      assert.ok(signal.timestamp);
    });

    it('builds a valid revert signal', () => {
      const signal = buildA1WorldTruthSignal({
        type: 'revert',
        ref: 'commit abc123',
        outcome: 'failure',
      });
      assert.equal(signal.type, 'revert');
      assert.equal(signal.outcome, 'failure');
    });
  });
});
