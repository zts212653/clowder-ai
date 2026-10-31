/**
 * F192 Day-24 verdict fix — magic_word_ref idempotency guard tests.
 *
 * Verifies that:
 * 1. Same eventId appended twice to same episode produces only one signal
 * 2. Different eventIds on same episode both insert
 * 3. Same eventId replayed after episode completion is blocked (cross-episode dedup)
 *
 * [宪宪/Opus-46🐾]
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { appendMagicWordRefToEpisode } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-signal-wiring.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

describe('magic_word_ref idempotency (Day-24 verdict fix)', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
  });

  it('same eventId appended twice to same episode produces only one signal', () => {
    const threadId = 'thread_mw_dedup';
    const ep = store.createEpisode({ trigger: 'user_ask', threadId, participants: ['opus'] });

    const r1 = appendMagicWordRefToEpisode(store, {
      eventId: 'evt_dedup_test',
      word: '下次一定',
      threadId,
      catId: 'opus',
    });
    assert.equal(r1.signalAppended, true);

    const r2 = appendMagicWordRefToEpisode(store, {
      eventId: 'evt_dedup_test',
      word: '下次一定',
      threadId,
      catId: 'opus',
    });
    assert.equal(r2.signalAppended, false, 'duplicate eventId should be silently deduped');

    const signals = store.getSignals(ep.episodeId);
    const mwrSignals = signals.filter((s) => s.record.type === 'magic_word_ref');
    assert.equal(mwrSignals.length, 1, 'only one magic_word_ref signal for same eventId');
  });

  it('different eventIds on same episode both insert', () => {
    const threadId = 'thread_mw_diff';
    store.createEpisode({ trigger: 'user_ask', threadId, participants: ['opus'] });

    appendMagicWordRefToEpisode(store, { eventId: 'evt_a', word: '脚手架', threadId, catId: 'opus' });
    appendMagicWordRefToEpisode(store, { eventId: 'evt_b', word: '绕路了', threadId, catId: 'opus' });

    const ep = store.getActiveEpisode(threadId);
    const signals = store.getSignals(ep.episodeId);
    assert.equal(signals.filter((s) => s.record.type === 'magic_word_ref').length, 2);
  });

  it('same eventId replayed after episode completion is blocked (cross-episode dedup)', () => {
    const threadId = 'thread_mw_cross_ep';
    const ep1 = store.createEpisode({ trigger: 'user_ask', threadId, participants: ['opus'] });

    // First append: succeeds
    const r1 = appendMagicWordRefToEpisode(store, {
      eventId: 'evt_replay',
      word: '下次一定',
      threadId,
      catId: 'opus',
    });
    assert.equal(r1.signalAppended, true);
    assert.equal(r1.episodeId, ep1.episodeId);

    // Complete the episode (no longer active)
    store.updateTerminalState(ep1.episodeId, 'completed');

    // Same eventId replayed — should NOT create a phantom episode
    const r2 = appendMagicWordRefToEpisode(store, {
      eventId: 'evt_replay',
      word: '下次一定',
      threadId,
      catId: 'opus',
    });
    assert.equal(r2.signalAppended, false, 'cross-episode replay should be blocked');

    // No phantom episode should have been created
    const activeAfter = store.getActiveEpisode(threadId);
    assert.equal(activeAfter, null, 'no phantom in_progress episode should exist');

    // Original episode still has exactly one signal
    const signals = store.getSignals(ep1.episodeId);
    assert.equal(signals.filter((s) => s.record.type === 'magic_word_ref').length, 1);
  });
});
