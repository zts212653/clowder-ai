import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
  handleMagicWord,
  handlePermissionCancel,
  handleUpdateTerminalState,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-routes.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

describe('Task Outcome API Handlers (F192 Phase G)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
  });

  describe('handlePermissionCancel', () => {
    it('records a cancel and auto-creates episode if none exists', () => {
      const result = handlePermissionCancel(store, {
        toolName: 'cat_cafe_hold_ball',
        paramsSummary: 'reason: "waiting"',
        reason: 'wrong_direction',
        catId: 'opus',
        threadId: 'thread_abc',
        sessionId: 'session_1',
      });
      assert.ok(result.episodeId);
      assert.equal(result.signalAppended, true);

      const episode = store.getEpisode(result.episodeId);
      assert.ok(episode);
      const signals = store.getSignals(result.episodeId);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].record.type, 'permission_cancel');
      assert.equal(signals[0].record.toolName, 'cat_cafe_hold_ball');
    });

    it('appends cancel to existing active episode', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });

      const result = handlePermissionCancel(store, {
        toolName: 'cat_cafe_post_message',
        catId: 'opus',
        threadId: 'thread_abc',
      });
      assert.equal(result.episodeId, ep.episodeId);
      assert.equal(result.signalAppended, true);
    });

    it('defaults reason to skip', () => {
      const result = handlePermissionCancel(store, {
        toolName: 'edit_file',
        catId: 'opus',
        threadId: 'thread_abc',
      });
      const signals = store.getSignals(result.episodeId);
      assert.equal(signals[0].record.reason, 'skip');
    });
  });

  describe('handleMagicWord', () => {
    it('records a magic word signal', () => {
      const result = handleMagicWord(store, {
        word: '脚手架',
        catId: 'opus',
        threadId: 'thread_abc',
      });
      assert.ok(result.episodeId);
      assert.equal(result.signalAppended, true);

      const signals = store.getSignals(result.episodeId);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].record.word, '脚手架');
    });
  });

  describe('handleA1WorldTruth', () => {
    it('records a merge event', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });

      const result = handleA1WorldTruth(store, {
        type: 'merge',
        ref: 'PR#2073',
        outcome: 'success',
        threadId: 'thread_abc',
      });
      assert.equal(result.episodeId, ep.episodeId);

      const signals = store.getSignals(ep.episodeId);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].category, 'a1');
    });

    it('auto-transitions episode to completed on merge+success', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });
      assert.equal(ep.terminalState, 'in_progress');

      handleA1WorldTruth(store, {
        type: 'merge',
        ref: 'PR#2074',
        outcome: 'success',
        threadId: 'thread_abc',
      });

      const updated = store.getEpisode(ep.episodeId);
      assert.equal(updated.terminalState, 'completed');

      // Episode now appears in needsVerdict queue
      const needing = store.listNeedingVerdict();
      assert.ok(needing.some((e) => e.episodeId === ep.episodeId));
    });

    it('does NOT auto-close on revert (negative signal only, cat may redo work)', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });

      handleA1WorldTruth(store, {
        type: 'revert',
        ref: 'commit abc123',
        outcome: 'success',
        threadId: 'thread_abc',
      });

      const updated = store.getEpisode(ep.episodeId);
      assert.equal(updated.terminalState, 'in_progress');
      // Signal is still recorded
      const signals = store.getSignals(ep.episodeId);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].record.type, 'revert');
    });

    it('does NOT auto-transition on merge+failure', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });

      handleA1WorldTruth(store, {
        type: 'merge',
        ref: 'PR#9999',
        outcome: 'failure',
        threadId: 'thread_abc',
      });

      const updated = store.getEpisode(ep.episodeId);
      assert.equal(updated.terminalState, 'in_progress');
    });

    it('does NOT auto-transition test_pass (signal only)', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });

      handleA1WorldTruth(store, {
        type: 'test_pass',
        ref: 'test suite',
        outcome: 'success',
        threadId: 'thread_abc',
      });

      const updated = store.getEpisode(ep.episodeId);
      assert.equal(updated.terminalState, 'in_progress');
    });
  });

  describe('handleGetEpisode', () => {
    it('returns episode with all signals assembled', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });
      handlePermissionCancel(store, {
        toolName: 'hold_ball',
        reason: 'should_not_do',
        catId: 'opus',
        threadId: 'thread_abc',
      });
      handleA1WorldTruth(store, {
        type: 'merge',
        ref: 'PR#1',
        outcome: 'success',
        threadId: 'thread_abc',
      });

      const result = handleGetEpisode(store, ep.episodeId);
      assert.ok(result);
      assert.equal(result.episodeId, ep.episodeId);
      assert.equal(result.signals.a1WorldTruth.length, 1);
      assert.equal(result.signals.a2InteractionDecisions.length, 1);
    });

    it('returns null for non-existent episode', () => {
      assert.equal(handleGetEpisode(store, 'ep-fake'), null);
    });
  });

  describe('handleUpdateTerminalState', () => {
    it('transitions episode from in_progress to completed', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });
      assert.equal(ep.terminalState, 'in_progress');

      const result = handleUpdateTerminalState(store, {
        episodeId: ep.episodeId,
        terminalState: 'completed',
      });
      assert.ok(result);
      assert.equal(result.terminalState, 'completed');
    });

    it('returns null for non-existent episode', () => {
      assert.equal(
        handleUpdateTerminalState(store, {
          episodeId: 'ep-fake',
          terminalState: 'completed',
        }),
        null,
      );
    });

    it('completed episode enters listNeedingVerdict queue', () => {
      const ep = store.createEpisode({
        trigger: 'user_ask',
        threadId: 'thread_abc',
        participants: ['opus'],
      });
      handleUpdateTerminalState(store, {
        episodeId: ep.episodeId,
        terminalState: 'completed',
      });
      const needing = store.listNeedingVerdict();
      assert.equal(needing.length, 1);
      assert.equal(needing[0].episodeId, ep.episodeId);
    });
  });

  describe('handleListEpisodes', () => {
    it('lists episodes for a thread', () => {
      store.createEpisode({ trigger: 'user_ask', threadId: 'thread_abc', participants: ['opus'] });
      store.createEpisode({ trigger: 'user_ask', threadId: 'thread_abc', participants: ['codex'] });
      store.createEpisode({ trigger: 'user_ask', threadId: 'thread_xyz', participants: ['opus'] });

      const result = handleListEpisodes(store, 'thread_abc');
      assert.equal(result.length, 2);
    });
  });
});
