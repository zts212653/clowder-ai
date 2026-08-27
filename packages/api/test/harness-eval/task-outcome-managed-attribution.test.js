import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  appendMagicWordRefToEpisode,
  appendPrLifecycleEvidenceToEpisode,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-signal-wiring.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

describe('F275 managed-work outcome attribution', () => {
  /** @type {TaskOutcomeEpisodeStore} */
  let store;

  beforeEach(() => {
    store = new TaskOutcomeEpisodeStore(':memory:');
    store.getActiveEpisode = () => {
      throw new Error('task-level attribution must not use latest-by-thread');
    };
  });

  it('isolates two managed works, unmanaged chat, and missing PR binding in one thread', () => {
    const threadId = 'thread_shared';
    const workA = { workId: 'wrk_a', attemptId: 'wat_a_1' };
    const workB = { workId: 'wrk_b', attemptId: 'wat_b_1' };

    const episodeA = store.createEpisode({
      trigger: 'task_created',
      threadId,
      participants: ['codex-sol'],
      attribution: 'managed_attributed',
      ...workA,
    });
    const episodeB = store.createEpisode({
      trigger: 'task_created',
      threadId,
      participants: ['codex-terra'],
      attribution: 'managed_attributed',
      ...workB,
    });
    const chat = appendMagicWordRefToEpisode(store, {
      eventId: 'evt_chat',
      word: '喵约',
      threadId,
      catId: 'codex-sol',
    });

    const mergeA = appendPrLifecycleEvidenceToEpisode(store, {
      type: 'merge',
      ref: 'pr:zts212653/cat-cafe#42',
      outcome: 'success',
      threadId,
      managedWorkBinding: workA,
    });
    const duplicateMergeA = appendPrLifecycleEvidenceToEpisode(store, {
      type: 'merge',
      ref: 'pr:zts212653/cat-cafe#42',
      outcome: 'success',
      threadId,
      managedWorkBinding: workA,
    });
    const missing = appendPrLifecycleEvidenceToEpisode(store, {
      type: 'merge',
      ref: 'pr:zts212653/cat-cafe#43',
      outcome: 'success',
      threadId,
    });

    assert.equal(mergeA.episodeId, episodeA.episodeId, 'work A merge must join work A only');
    assert.equal(duplicateMergeA.signalAppended, false, 'replayed PR evidence must be idempotent');
    assert.notEqual(mergeA.episodeId, episodeB.episodeId);
    assert.notEqual(mergeA.episodeId, chat.episodeId);
    assert.notEqual(missing.episodeId, mergeA.episodeId);

    const storedEpisodeA = store.getEpisode(episodeA.episodeId);
    const storedEpisodeB = store.getEpisode(episodeB.episodeId);
    const chatEpisode = store.getEpisode(chat.episodeId);
    const unattributedEpisode = store.getEpisode(missing.episodeId);

    assert.deepEqual(
      {
        attribution: storedEpisodeA?.attribution,
        workId: storedEpisodeA?.workId,
        attemptId: storedEpisodeA?.attemptId,
      },
      { attribution: 'managed_attributed', workId: 'wrk_a', attemptId: 'wat_a_1' },
    );
    assert.deepEqual(
      {
        attribution: storedEpisodeB?.attribution,
        workId: storedEpisodeB?.workId,
        attemptId: storedEpisodeB?.attemptId,
      },
      { attribution: 'managed_attributed', workId: 'wrk_b', attemptId: 'wat_b_1' },
    );
    assert.deepEqual(
      { attribution: chatEpisode?.attribution, workId: chatEpisode?.workId, attemptId: chatEpisode?.attemptId },
      { attribution: 'unmanaged_not_applicable', workId: null, attemptId: null },
    );
    assert.deepEqual(
      {
        attribution: unattributedEpisode?.attribution,
        workId: unattributedEpisode?.workId,
        attemptId: unattributedEpisode?.attemptId,
      },
      { attribution: 'managed_unattributed', workId: null, attemptId: null },
    );

    assert.equal(store.getSignals(episodeA.episodeId).filter((signal) => signal.record.type === 'merge').length, 1);
    assert.equal(store.getSignals(episodeB.episodeId).filter((signal) => signal.record.type === 'merge').length, 0);
    assert.equal(storedEpisodeA?.terminalState, 'in_progress', 'PR merge is evidence, not work terminal authority');
  });

  it('keeps separate unattributed episodes for separate PR artifacts in one thread', () => {
    const input = { type: 'merge', outcome: 'success', threadId: 'thread_shared' };
    const repoA = appendPrLifecycleEvidenceToEpisode(store, {
      ...input,
      ref: 'pr:owner/repo-a#43',
    });
    const repoB = appendPrLifecycleEvidenceToEpisode(store, {
      ...input,
      ref: 'pr:owner/repo-b#43',
    });
    const replayA = appendPrLifecycleEvidenceToEpisode(store, {
      ...input,
      ref: 'pr:owner/repo-a#43',
    });

    assert.notEqual(repoA.episodeId, repoB.episodeId, 'unbound PR artifacts must never join by thread recency');
    assert.equal(replayA.episodeId, repoA.episodeId, 'same artifact replay must reuse its unattributed episode');
    assert.equal(replayA.signalAppended, false);
    assert.deepEqual(store.getEpisode(repoA.episodeId)?.artifacts, ['pr:owner/repo-a#43']);
    assert.deepEqual(store.getEpisode(repoB.episodeId)?.artifacts, ['pr:owner/repo-b#43']);
  });

  it('deduplicates PR replay before creating a replacement for a terminalized episode', () => {
    const input = {
      type: 'merge',
      ref: 'pr:owner/repo#44',
      outcome: 'success',
      threadId: 'thread_replay',
    };
    const first = appendPrLifecycleEvidenceToEpisode(store, input);
    store.updateTerminalState(first.episodeId, 'completed');

    const replay = appendPrLifecycleEvidenceToEpisode(store, input);

    assert.equal(replay.signalAppended, false);
    assert.equal(store.listByThread(input.threadId).length, 1, 'replay must not create a phantom episode');
    assert.equal(
      store.getActiveEpisodeByAttribution({
        attribution: 'managed_unattributed',
        artifactRef: input.ref,
      }),
      null,
      'terminal evidence must stay terminal after replay',
    );
  });
});
