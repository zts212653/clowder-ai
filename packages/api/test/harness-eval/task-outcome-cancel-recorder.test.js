import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildA1WorldTruthSignal,
  buildMagicWordSignal,
  buildPermissionCancelSignal,
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
        followingMessageSummary: 'CVO told cat to rethink',
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
