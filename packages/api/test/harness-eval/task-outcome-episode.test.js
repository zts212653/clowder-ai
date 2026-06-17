import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseA1WorldTruthRecord,
  parseMagicWordRecord,
  parseMagicWordRefRecord,
  parsePermissionCancelRecord,
  parseTaskOutcomeEpisode,
  VERDICT_CLASSES,
} from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-episode.js';

// ---- Fixtures ----

const validEpisode = {
  episodeId: 'ep-1717401600000',
  trigger: 'user_ask',
  threadId: 'thread_abc123',
  participants: ['opus', 'codex'],
  artifacts: ['commit abc123', 'doc xyz.md'],
  signals: {
    a1WorldTruth: [],
    a2InteractionDecisions: [],
    proxy: [],
  },
  terminalState: 'completed',
  verdict: null,
  createdAt: '2026-06-03T12:00:00.000Z',
};

const validPermissionCancel = {
  type: 'permission_cancel',
  toolName: 'cat_cafe_hold_ball',
  paramsSummary: 'reason: "waiting for cloud review"',
  reason: 'wrong_direction',
  timestamp: '2026-06-03T12:05:00.000Z',
  catId: 'opus',
  threadId: 'thread_abc123',
  sessionId: 'session_xyz',
};

const validMagicWord = {
  type: 'magic_word',
  word: '脚手架',
  timestamp: '2026-06-03T12:10:00.000Z',
  threadId: 'thread_abc123',
  catId: 'opus',
  precedingMessageSummary: 'Cat was writing a temporary fix for the routing issue',
  followingMessageSummary: 'operator told cat to rethink the approach from first principles',
};

const validMagicWordRef = {
  type: 'magic_word_ref',
  eventId: 'evt_abc123',
  word: '脚手架',
  timestamp: '2026-06-03T12:10:00.000Z',
  threadId: 'thread_abc123',
  catId: 'opus',
};

const validA1WorldTruth = {
  type: 'merge',
  ref: 'PR#2073',
  outcome: 'success',
  timestamp: '2026-06-03T14:00:00.000Z',
};

// ---- Tests ----

describe('TaskOutcomeEpisode schema (F192 Phase G)', () => {
  describe('parseTaskOutcomeEpisode', () => {
    it('accepts a minimal valid episode', () => {
      const ep = parseTaskOutcomeEpisode(validEpisode);
      assert.equal(ep.episodeId, 'ep-1717401600000');
      assert.equal(ep.trigger, 'user_ask');
      assert.equal(ep.terminalState, 'completed');
      assert.equal(ep.verdict, null);
    });

    it('accepts all valid trigger types', () => {
      for (const trigger of ['user_ask', 'task_created', 'cat_initiated']) {
        const ep = parseTaskOutcomeEpisode({ ...validEpisode, trigger });
        assert.equal(ep.trigger, trigger);
      }
    });

    it('accepts all valid terminal states including in_progress', () => {
      for (const terminalState of [
        'in_progress',
        'completed',
        'abandoned',
        'escalated_cvo',
        'corrected_then_completed',
      ]) {
        const ep = parseTaskOutcomeEpisode({ ...validEpisode, terminalState });
        assert.equal(ep.terminalState, terminalState);
      }
    });

    it('accepts all valid verdict classes', () => {
      for (const verdict of VERDICT_CLASSES) {
        const ep = parseTaskOutcomeEpisode({ ...validEpisode, verdict });
        assert.equal(ep.verdict, verdict);
      }
    });

    it('accepts verdict = null (not yet evaluated)', () => {
      const ep = parseTaskOutcomeEpisode({ ...validEpisode, verdict: null });
      assert.equal(ep.verdict, null);
    });

    it('accepts episode with populated signals', () => {
      const ep = parseTaskOutcomeEpisode({
        ...validEpisode,
        signals: {
          a1WorldTruth: [validA1WorldTruth],
          a2InteractionDecisions: [validPermissionCancel, validMagicWord],
          proxy: [{ type: 'cancel_count', value: 3 }],
        },
      });
      assert.equal(ep.signals.a1WorldTruth.length, 1);
      assert.equal(ep.signals.a2InteractionDecisions.length, 2);
      assert.equal(ep.signals.proxy.length, 1);
    });

    it('rejects episode without episodeId', () => {
      const { episodeId: _, ...noId } = validEpisode;
      assert.throws(() => parseTaskOutcomeEpisode(noId));
    });

    it('rejects episode with invalid trigger', () => {
      assert.throws(() => parseTaskOutcomeEpisode({ ...validEpisode, trigger: 'random' }));
    });

    it('rejects episode with invalid terminalState', () => {
      assert.throws(() => parseTaskOutcomeEpisode({ ...validEpisode, terminalState: 'unknown' }));
    });

    it('rejects episode with invalid verdict', () => {
      assert.throws(() => parseTaskOutcomeEpisode({ ...validEpisode, verdict: 'score_5' }));
    });
  });

  describe('parsePermissionCancelRecord', () => {
    it('accepts a valid cancel with reason', () => {
      const rec = parsePermissionCancelRecord(validPermissionCancel);
      assert.equal(rec.type, 'permission_cancel');
      assert.equal(rec.toolName, 'cat_cafe_hold_ball');
      assert.equal(rec.reason, 'wrong_direction');
    });

    it('accepts cancel without reason (skip)', () => {
      const rec = parsePermissionCancelRecord({
        ...validPermissionCancel,
        reason: 'skip',
      });
      assert.equal(rec.reason, 'skip');
    });

    it('accepts all valid cancel reasons', () => {
      for (const reason of ['should_not_do', 'wrong_direction', 'i_will_do_it', 'skip']) {
        const rec = parsePermissionCancelRecord({ ...validPermissionCancel, reason });
        assert.equal(rec.reason, reason);
      }
    });

    it('rejects cancel without toolName', () => {
      const { toolName: _, ...noTool } = validPermissionCancel;
      assert.throws(() => parsePermissionCancelRecord(noTool));
    });

    it('rejects cancel with invalid reason', () => {
      assert.throws(() => parsePermissionCancelRecord({ ...validPermissionCancel, reason: 'bad_reason' }));
    });
  });

  describe('parseMagicWordRecord', () => {
    it('accepts a valid magic word record', () => {
      const rec = parseMagicWordRecord(validMagicWord);
      assert.equal(rec.type, 'magic_word');
      assert.equal(rec.word, '脚手架');
      assert.equal(rec.catId, 'opus');
    });

    it('allows optional preceding/following summaries', () => {
      const { precedingMessageSummary: _, followingMessageSummary: __, ...minimal } = validMagicWord;
      const rec = parseMagicWordRecord(minimal);
      assert.equal(rec.word, '脚手架');
    });

    it('rejects magic word without word field', () => {
      const { word: _, ...noWord } = validMagicWord;
      assert.throws(() => parseMagicWordRecord(noWord));
    });
  });

  describe('parseMagicWordRefRecord (F227 归一)', () => {
    it('accepts a valid magic word ref', () => {
      const rec = parseMagicWordRefRecord(validMagicWordRef);
      assert.equal(rec.type, 'magic_word_ref');
      assert.equal(rec.eventId, 'evt_abc123');
      assert.equal(rec.word, '脚手架');
      assert.equal(rec.catId, 'opus');
    });

    it('rejects a ref without eventId (Event Memory pointer is required)', () => {
      const { eventId: _, ...noEventId } = validMagicWordRef;
      assert.throws(() => parseMagicWordRefRecord(noEventId));
    });

    it('rejects a ref without word (projection field required)', () => {
      const { word: _, ...noWord } = validMagicWordRef;
      assert.throws(() => parseMagicWordRefRecord(noWord));
    });

    it('is accepted by the a2 discriminated union inside an episode', () => {
      const ep = parseTaskOutcomeEpisode({
        ...validEpisode,
        signals: {
          a1WorldTruth: [],
          a2InteractionDecisions: [validMagicWordRef],
          proxy: [],
        },
      });
      assert.equal(ep.signals.a2InteractionDecisions.length, 1);
      assert.equal(ep.signals.a2InteractionDecisions[0].type, 'magic_word_ref');
    });
  });

  describe('parseA1WorldTruthRecord', () => {
    it('accepts a valid merge event', () => {
      const rec = parseA1WorldTruthRecord(validA1WorldTruth);
      assert.equal(rec.type, 'merge');
      assert.equal(rec.outcome, 'success');
    });

    it('accepts all valid A1 types', () => {
      for (const type of ['merge', 'revert', 'test_pass', 'test_fail', 'build_pass', 'build_fail']) {
        const rec = parseA1WorldTruthRecord({ ...validA1WorldTruth, type });
        assert.equal(rec.type, type);
      }
    });

    it('accepts all valid outcomes', () => {
      for (const outcome of ['success', 'failure']) {
        const rec = parseA1WorldTruthRecord({ ...validA1WorldTruth, outcome });
        assert.equal(rec.outcome, outcome);
      }
    });

    it('rejects A1 record with invalid type', () => {
      assert.throws(() => parseA1WorldTruthRecord({ ...validA1WorldTruth, type: 'deploy' }));
    });
  });
});
