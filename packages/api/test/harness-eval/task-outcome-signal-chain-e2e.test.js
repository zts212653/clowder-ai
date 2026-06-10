/**
 * F192 Phase G AC-G11 — Task Outcome Signal Chain End-to-End Integration Test.
 *
 * Verifies the complete signal chain flows through real store + real handlers:
 *   cancel+reason → episode a2 signal
 *   magic_word_ref → projected as magic_word in episode read-side
 *   cancel burst (≥3 in 60s) → proxy signal
 *   A1 merge+success → auto-complete episode
 *   episode query returns all signals correctly grouped
 *
 * This is NOT a unit test — it wires real SQLite store, real route handlers,
 * and real CancelBurstDetector to prove the chain works end-to-end.
 *
 * [宪宪/Opus-46🐾]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CancelBurstDetector } from '../../dist/infrastructure/harness-eval/task-outcome/cancel-burst-detector.js';
import {
  handleA1WorldTruth,
  handleGetEpisode,
  handleListEpisodes,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-routes.js';
import {
  appendMagicWordRefToEpisode,
  appendPermissionCancelToEpisode,
  checkAndAppendCancelBurst,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-signal-wiring.js';
import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';

// ---- Test fixtures ----

const THREAD_ID = 'thread_e2e_test_signal_chain';
const CAT_ID = 'opus';

describe('AC-G11 Task Outcome Signal Chain E2E', () => {
  let store;
  let burstDetector;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-outcome-e2e-'));
    const dbPath = path.join(tmpDir, 'test-episodes.sqlite');
    store = new TaskOutcomeEpisodeStore(dbPath);
    burstDetector = new CancelBurstDetector({ threshold: 3, windowMs: 60_000 });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Signal Chain 1: Cancel with reason → episode a2 signal
  // =========================================================================

  describe('Chain 1: Permission cancel with structured reason → episode a2', () => {
    it('production helper creates episode and appends a2 signal with normalized reason', () => {
      // Use the SAME production helper that index.ts onPermissionCancel calls
      const result = appendPermissionCancelToEpisode(store, {
        toolName: 'Bash',
        paramsSummary: 'rm -rf /',
        cancelReason: 'should_not_do',
        catId: CAT_ID,
        threadId: THREAD_ID,
      });

      assert.ok(result.episodeId, 'should return episodeId');
      assert.equal(result.signalAppended, true);

      // Verify episode exists and is in_progress
      const episode = handleGetEpisode(store, result.episodeId);
      assert.ok(episode, 'episode should exist');
      assert.equal(episode.terminalState, 'in_progress');
      assert.equal(episode.threadId, THREAD_ID);

      // Verify a2 signal contains the reason
      assert.equal(episode.signals.a2InteractionDecisions.length, 1);
      const signal = episode.signals.a2InteractionDecisions[0];
      assert.equal(signal.type, 'permission_cancel');
      assert.equal(signal.reason, 'should_not_do');
      assert.equal(signal.toolName, 'Bash');
    });

    it('appends second cancel with different reason to same episode', () => {
      const result = appendPermissionCancelToEpisode(store, {
        toolName: 'Edit',
        cancelReason: 'wrong_direction',
        catId: CAT_ID,
        threadId: THREAD_ID,
      });

      const episode = handleGetEpisode(store, result.episodeId);
      assert.equal(episode.signals.a2InteractionDecisions.length, 2);
      assert.equal(episode.signals.a2InteractionDecisions[1].reason, 'wrong_direction');
    });

    it('normalizes invalid cancelReason to skip (production reason validation)', () => {
      // Production path receives raw strings from frontend; invalid → 'skip'
      const isolatedThread = 'thread_e2e_reason_normalization';
      const result = appendPermissionCancelToEpisode(store, {
        toolName: 'Bash',
        cancelReason: 'some_random_frontend_string',
        catId: CAT_ID,
        threadId: isolatedThread,
      });

      const episode = handleGetEpisode(store, result.episodeId);
      assert.equal(episode.signals.a2InteractionDecisions[0].reason, 'skip');
    });
  });

  // =========================================================================
  // Signal Chain 2: Magic word ref → projected as magic_word in read-side
  // =========================================================================

  describe('Chain 2: Magic word ref signal → projected as magic_word', () => {
    it('production helper appends magic_word_ref, projected to magic_word on read', () => {
      // Use the SAME production helper that index.ts onMagicWordDetected calls
      const result = appendMagicWordRefToEpisode(store, {
        eventId: 'evt_test_magic_word_001',
        word: '补锅匠',
        threadId: THREAD_ID,
        catId: CAT_ID,
      });

      assert.ok(result.episodeId, 'should return episodeId');
      assert.equal(result.signalAppended, true);

      // Read episode — projection should convert magic_word_ref → magic_word
      const episode = handleGetEpisode(store, result.episodeId);
      const magicWordSignals = episode.signals.a2InteractionDecisions.filter((s) => s.type === 'magic_word');

      assert.equal(magicWordSignals.length, 1, 'should have 1 projected magic_word');
      assert.equal(magicWordSignals[0].word, '补锅匠');
      assert.equal(magicWordSignals[0].eventId, 'evt_test_magic_word_001');
      // Original type in store is magic_word_ref, but read-side projects to magic_word
      assert.equal(magicWordSignals[0].type, 'magic_word');
    });
  });

  // =========================================================================
  // Signal Chain 3: Cancel burst (≥3 in window) → proxy signal
  // =========================================================================

  describe('Chain 3: Cancel burst detection → proxy signal', () => {
    it('production helper detects burst at threshold and appends proxy signal', () => {
      const now = Date.now();

      // Use the SAME production helper that index.ts onPermissionCancel calls.
      // First 2 cancels — no burst
      const r1 = checkAndAppendCancelBurst(store, burstDetector, THREAD_ID, now);
      assert.equal(r1.burst, false);
      assert.equal(r1.proxyAppended, false);

      const r2 = checkAndAppendCancelBurst(store, burstDetector, THREAD_ID, now + 10_000);
      assert.equal(r2.burst, false);
      assert.equal(r2.proxyAppended, false);

      // Third cancel — burst! Helper should auto-append proxy signal
      const r3 = checkAndAppendCancelBurst(store, burstDetector, THREAD_ID, now + 20_000);
      assert.equal(r3.burst, true);
      assert.equal(r3.count, 3);
      assert.ok(r3.episodeId, 'should return episodeId when burst appended');
      assert.equal(r3.proxyAppended, true);

      // Verify proxy signal visible in episode
      const episode = handleGetEpisode(store, r3.episodeId);
      assert.equal(episode.signals.proxy.length, 1);
      assert.equal(episode.signals.proxy[0].type, 'cancel_burst');
      assert.equal(episode.signals.proxy[0].value, 3);
    });
  });

  // =========================================================================
  // Signal Chain 4: A1 merge+success → auto-complete episode
  // =========================================================================

  describe('Chain 4: A1 world truth merge+success → auto-complete', () => {
    it('merge+success appends a1 signal and auto-completes episode', () => {
      const activeEpisode = store.getActiveEpisode(THREAD_ID);
      assert.ok(activeEpisode, 'should have active episode');
      assert.equal(activeEpisode.terminalState, 'in_progress');

      const result = handleA1WorldTruth(store, {
        type: 'merge',
        ref: 'PR #2099',
        outcome: 'success',
        threadId: THREAD_ID,
      });

      // Episode should be auto-completed
      const episode = handleGetEpisode(store, result.episodeId);
      assert.equal(episode.terminalState, 'completed');

      // a1 signal present
      assert.equal(episode.signals.a1WorldTruth.length, 1);
      assert.equal(episode.signals.a1WorldTruth[0].type, 'merge');
      assert.equal(episode.signals.a1WorldTruth[0].outcome, 'success');
    });

    it('revert does NOT auto-close episode', () => {
      // New thread for isolation — use production helper to create episode
      const revertThread = 'thread_e2e_revert_test';
      const createResult = appendPermissionCancelToEpisode(store, {
        toolName: 'test',
        catId: CAT_ID,
        threadId: revertThread,
      });

      handleA1WorldTruth(store, {
        type: 'revert',
        ref: 'commit abc123',
        outcome: 'failure',
        threadId: revertThread,
      });

      const episode = handleGetEpisode(store, createResult.episodeId);
      // Still in_progress — revert is signal only, not auto-close
      assert.equal(episode.terminalState, 'in_progress');
      assert.equal(episode.signals.a1WorldTruth.length, 1);
      assert.equal(episode.signals.a1WorldTruth[0].type, 'revert');
    });
  });

  // =========================================================================
  // Signal Chain 5: Full episode query — all signals correctly grouped
  // =========================================================================

  describe('Chain 5: Full assembled episode — signals grouped by category', () => {
    it('completed episode has all signal categories populated', () => {
      // The THREAD_ID episode was completed by Chain 4.
      // It should have: 2 permission_cancel a2, 1 magic_word a2, 1 cancel_burst proxy, 1 merge a1
      const episodes = handleListEpisodes(store, THREAD_ID);
      assert.ok(episodes.length >= 1, 'should have at least 1 episode');

      const assembled = handleGetEpisode(store, episodes[0].episodeId);
      assert.ok(assembled, 'assembled episode should exist');

      // a2: 2 permission_cancel + 1 projected magic_word = 3
      assert.equal(assembled.signals.a2InteractionDecisions.length, 3);
      const cancelSignals = assembled.signals.a2InteractionDecisions.filter((s) => s.type === 'permission_cancel');
      assert.equal(cancelSignals.length, 2);
      const magicSignals = assembled.signals.a2InteractionDecisions.filter((s) => s.type === 'magic_word');
      assert.equal(magicSignals.length, 1);

      // proxy: 1 cancel_burst
      assert.equal(assembled.signals.proxy.length, 1);
      assert.equal(assembled.signals.proxy[0].type, 'cancel_burst');

      // a1: 1 merge
      assert.equal(assembled.signals.a1WorldTruth.length, 1);
      assert.equal(assembled.signals.a1WorldTruth[0].type, 'merge');

      // Episode metadata
      assert.equal(assembled.terminalState, 'completed');
      assert.equal(assembled.threadId, THREAD_ID);
    });

    it('listNeedingVerdict returns completed episode without verdict', () => {
      const needing = store.listNeedingVerdict();
      const ours = needing.find((e) => e.threadId === THREAD_ID);
      assert.ok(ours, 'completed episode should appear in listNeedingVerdict');
      assert.equal(ours.verdict, null);
    });
  });

  // =========================================================================
  // Signal Chain 6: Verdict assignment closes the loop
  // =========================================================================

  describe('Chain 6: Verdict assignment removes from needingVerdict', () => {
    it('updateVerdict + verify no longer in needingVerdict list', () => {
      const episodes = handleListEpisodes(store, THREAD_ID);
      const episodeId = episodes[0].episodeId;

      store.updateVerdict(episodeId, 'success');

      const episode = handleGetEpisode(store, episodeId);
      assert.equal(episode.verdict, 'success');

      // Should no longer appear in needingVerdict
      const needing = store.listNeedingVerdict();
      const ours = needing.find((e) => e.threadId === THREAD_ID);
      assert.equal(ours, undefined, 'verdicted episode should not be in needingVerdict');
    });
  });
});
