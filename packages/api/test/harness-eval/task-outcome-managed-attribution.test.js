import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { CancelBurstDetector } from '../../dist/infrastructure/harness-eval/task-outcome/cancel-burst-detector.js';
import {
  appendMagicWordRefToEpisode,
  appendPermissionCancelToEpisode,
  appendPrLifecycleEvidenceToEpisode,
  checkAndAppendCancelBurst,
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

    const aCancel = appendPermissionCancelToEpisode(store, {
      toolName: 'Bash',
      cancelReason: 'wrong_direction',
      catId: 'codex-sol',
      threadId,
      managedWorkBinding: workA,
    });
    const bCancel = appendPermissionCancelToEpisode(store, {
      toolName: 'Edit',
      cancelReason: 'skip',
      catId: 'codex-terra',
      threadId,
      managedWorkBinding: workB,
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

    assert.equal(mergeA.episodeId, aCancel.episodeId, 'work A merge must join work A only');
    assert.equal(duplicateMergeA.signalAppended, false, 'replayed PR evidence must be idempotent');
    assert.notEqual(mergeA.episodeId, bCancel.episodeId);
    assert.notEqual(mergeA.episodeId, chat.episodeId);
    assert.notEqual(missing.episodeId, mergeA.episodeId);

    const episodeA = store.getEpisode(aCancel.episodeId);
    const episodeB = store.getEpisode(bCancel.episodeId);
    const chatEpisode = store.getEpisode(chat.episodeId);
    const unattributedEpisode = store.getEpisode(missing.episodeId);

    assert.deepEqual(
      { attribution: episodeA?.attribution, workId: episodeA?.workId, attemptId: episodeA?.attemptId },
      { attribution: 'managed_attributed', workId: 'wrk_a', attemptId: 'wat_a_1' },
    );
    assert.deepEqual(
      { attribution: episodeB?.attribution, workId: episodeB?.workId, attemptId: episodeB?.attemptId },
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
    assert.equal(episodeA?.terminalState, 'in_progress', 'PR merge is evidence, not work terminal authority');
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

  it('partitions cancel burst windows by managed attempt inside one thread', () => {
    const detector = new CancelBurstDetector({ threshold: 3, windowMs: 60_000 });
    const threadId = 'thread_shared';
    const workA = { workId: 'wrk_a', attemptId: 'wat_a_1' };
    const workB = { workId: 'wrk_b', attemptId: 'wat_b_1' };
    appendPermissionCancelToEpisode(store, {
      toolName: 'Bash',
      catId: 'codex-sol',
      threadId,
      managedWorkBinding: workA,
    });
    appendPermissionCancelToEpisode(store, {
      toolName: 'Edit',
      catId: 'codex-terra',
      threadId,
      managedWorkBinding: workB,
    });

    assert.equal(checkAndAppendCancelBurst(store, detector, threadId, 1_000, workA).burst, false);
    assert.equal(checkAndAppendCancelBurst(store, detector, threadId, 2_000, workB).burst, false);
    assert.equal(checkAndAppendCancelBurst(store, detector, threadId, 3_000, workA).burst, false);
    const burstA = checkAndAppendCancelBurst(store, detector, threadId, 4_000, workA);

    assert.equal(burstA.burst, true);
    assert.equal(burstA.proxyAppended, true);
    assert.equal(
      store.getSignals(burstA.episodeId).filter((signal) => signal.record.type === 'cancel_burst').length,
      1,
    );
    const episodeB = store.getActiveEpisodeByAttribution({ attribution: 'managed_attributed', ...workB });
    assert.equal(
      store.getSignals(episodeB.episodeId).filter((signal) => signal.record.type === 'cancel_burst').length,
      0,
    );
  });
});
