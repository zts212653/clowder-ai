import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

describe('TaskOutcomeEpisodeStore (F192 Phase G)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
  });

  it('creates an episode and retrieves it', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    assert.ok(ep.episodeId.startsWith('ep-'));
    assert.equal(ep.trigger, 'user_ask');
    assert.equal(ep.threadId, 'thread_abc');
    assert.equal(ep.terminalState, 'in_progress');
    assert.equal(ep.verdict, null);

    const found = store.getEpisode(ep.episodeId);
    assert.deepEqual(found, ep);
  });

  it('returns null for non-existent episode', () => {
    assert.equal(store.getEpisode('ep-nonexistent'), null);
  });

  it('appends a permission cancel signal to an episode', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'permission_cancel',
        toolName: 'cat_cafe_hold_ball',
        reason: 'wrong_direction',
        timestamp: new Date().toISOString(),
        catId: 'opus',
        threadId: 'thread_abc',
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'a2');
    assert.equal(signals[0].record.type, 'permission_cancel');
  });

  it('appends a magic word signal to an episode', () => {
    const ep = store.createEpisode({
      trigger: 'task_created',
      threadId: 'thread_xyz',
      participants: ['codex'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a2',
      record: {
        type: 'magic_word',
        word: '脚手架',
        timestamp: new Date().toISOString(),
        threadId: 'thread_xyz',
        catId: 'codex',
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].record.type, 'magic_word');
  });

  it('appends an A1 world truth signal', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.appendSignal(ep.episodeId, {
      category: 'a1',
      record: {
        type: 'merge',
        ref: 'PR#2073',
        outcome: 'success',
        timestamp: new Date().toISOString(),
      },
    });
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'a1');
    assert.equal(signals[0].record.type, 'merge');
  });

  it('updates terminal state', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.updateTerminalState(ep.episodeId, 'completed');
    const updated = store.getEpisode(ep.episodeId);
    assert.equal(updated?.terminalState, 'completed');
  });

  it('updates verdict', () => {
    const ep = store.createEpisode({
      trigger: 'user_ask',
      threadId: 'thread_abc',
      participants: ['opus'],
    });
    store.updateVerdict(ep.episodeId, 'corrected_success');
    const updated = store.getEpisode(ep.episodeId);
    assert.equal(updated?.verdict, 'corrected_success');
  });

  it('lists episodes by threadId', () => {
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['codex'] });
    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_b', participants: ['opus'] });

    const threadA = store.listByThread('thread_a');
    assert.equal(threadA.length, 2);

    const threadB = store.listByThread('thread_b');
    assert.equal(threadB.length, 1);
  });

  it('lists episodes that need verdict (null verdict + completed)', () => {
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep1.episodeId, 'completed');

    const ep2 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep2.episodeId, 'completed');
    store.updateVerdict(ep2.episodeId, 'success');

    store.createEpisode({ trigger: 'user_ask', threadId: 'thread_b', participants: ['opus'] });
    // still in_progress — not ready for verdict

    const needsVerdict = store.listNeedingVerdict();
    assert.equal(needsVerdict.length, 1);
    assert.equal(needsVerdict[0].episodeId, ep1.episodeId);
  });

  it('getActiveEpisode returns an in_progress episode for a thread', () => {
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep1.episodeId, 'completed');
    const ep2 = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });

    const active = store.getActiveEpisode('thread_a');
    assert.equal(active?.episodeId, ep2.episodeId);
  });

  it('getActiveEpisode returns null when no in_progress episode', () => {
    const ep = store.createEpisode({ trigger: 'user_ask', threadId: 'thread_a', participants: ['opus'] });
    store.updateTerminalState(ep.episodeId, 'completed');
    assert.equal(store.getActiveEpisode('thread_a'), null);
  });
});
