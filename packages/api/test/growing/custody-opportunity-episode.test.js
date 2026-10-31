import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { custodyOpportunityEpisodeV1Schema } from '@cat-cafe/shared';
import {
  CustodyOpportunityCohortInvalidError,
  CustodyOpportunityEpisodeRecorder,
} from '../../dist/domains/growing/CustodyOpportunityEpisodeRecorder.js';

const sourceRevision = `sha256:${'a'.repeat(64)}`;

// Deterministic contract examples only. They are not real user episodes or dogfood evidence.

function baseInput(overrides = {}) {
  return {
    version: 1,
    ownerRef: 'user:owner-1',
    policyVersion: 'f310.phase-b.v1',
    source: {
      subjectRef: 'message:thread-contract:message-contract',
      sourceRevision,
      evidenceRefs: ['message:thread-contract:message-contract'],
    },
    window: { kind: 'action', openedAt: 100, closedAt: 200 },
    candidate: { state: 'exposed', exposedAt: 120, reasonCode: 'future_obligation' },
    policyDisposition: 'offer',
    userDisposition: {
      state: 'observed',
      result: 'accept',
      dispositionRef: 'message:thread-contract:message-contract#custody-offer',
    },
    custody: {
      state: 'admitted',
      taskRef: { subjectRef: 'task:work:task-contract', observedRevision: 1 },
      receiptRef: 'task:work:task-contract#custody-receipt',
    },
    opportunityAssessment: {
      state: 'present',
      evidenceRefs: ['message:thread-contract:message-contract#calibration'],
    },
    delayedOutcome: { state: 'pending' },
    interruption: { state: 'none_observed' },
    duplicatePromptRefs: [],
    ...overrides,
  };
}

describe('F310 custody opportunity evidence', () => {
  test('episodes are strict refs-only measurements with no lifecycle authority', () => {
    const recorder = new CustodyOpportunityEpisodeRecorder();
    const episode = recorder.record(baseInput());

    assert.deepEqual(custodyOpportunityEpisodeV1Schema.parse(episode), episode);
    assert.match(episode.episodeRef, /^f310_opp_[a-f0-9]{32}$/u);
    assert.deepEqual(Object.keys(recorder).sort(), ['episodes', 'invalidity']);
    for (const forbidden of [
      { sourcePayload: 'make slides about private strategy' },
      { taskDraft: { title: 'shadow Task' } },
      { admissionAction: 'create_task' },
      { blockTaskUntilReviewed: true },
      { resurrectTask: true },
    ]) {
      assert.equal(custodyOpportunityEpisodeV1Schema.safeParse({ ...episode, ...forbidden }).success, false);
    }
  });

  test('true-negative credit requires exposure, deliberate abstention, and an evidenced absent opportunity', () => {
    const recorder = new CustodyOpportunityEpisodeRecorder();
    recorder.record(
      baseInput({
        source: {
          subjectRef: 'message:thread-contract:abstain',
          sourceRevision,
          evidenceRefs: ['message:thread-contract:abstain'],
        },
        window: {
          kind: 'sampled_silent',
          openedAt: 300,
          closedAt: 400,
          sampling: { bucket: 'random', sampleRef: 'sample:random:1', policyVersion: 'f310.sampling.v1' },
        },
        candidate: { state: 'exposed', exposedAt: 320, reasonCode: 'casual_mention' },
        policyDisposition: 'abstain',
        userDisposition: { state: 'not_applicable' },
        custody: { state: 'no_task' },
        opportunityAssessment: {
          state: 'absent',
          evidenceRefs: ['message:thread-contract:abstain#calibration'],
        },
      }),
    );
    recorder.record(
      baseInput({
        source: {
          subjectRef: 'message:thread-contract:unknown-silence',
          sourceRevision,
          evidenceRefs: ['message:thread-contract:unknown-silence'],
        },
        window: {
          kind: 'sampled_silent',
          openedAt: 500,
          closedAt: 600,
          sampling: { bucket: 'risk_targeted', sampleRef: 'sample:risk:1', policyVersion: 'f310.sampling.v1' },
        },
        candidate: { state: 'not_exposed' },
        policyDisposition: 'uninformed_silence',
        userDisposition: { state: 'not_observed' },
        custody: { state: 'no_task' },
        opportunityAssessment: { state: 'unknown' },
      }),
    );

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.state, 'valid');
    assert.equal(snapshot.vector.silence.trueNegativeEligible, 1);
    assert.equal(snapshot.vector.silence.uninformed, 1);
    assert.equal(snapshot.vector.silence.unknownEarnedCredit, 0);

    assert.equal(
      custodyOpportunityEpisodeV1Schema.safeParse({
        ...recorder.list()[0],
        candidate: { state: 'not_exposed' },
        policyDisposition: 'abstain',
      }).success,
      false,
    );
  });

  test('action episodes and sampled silent windows enter one explicit denominator', () => {
    const recorder = new CustodyOpportunityEpisodeRecorder();
    recorder.record(baseInput());
    recorder.record(
      baseInput({
        source: {
          subjectRef: 'message:thread-contract:auto',
          sourceRevision,
          evidenceRefs: ['message:thread-contract:auto'],
        },
        policyDisposition: 'auto_admit',
        userDisposition: { state: 'not_applicable' },
        custody: {
          state: 'resumed',
          taskRef: { subjectRef: 'task:work:task-auto', observedRevision: 4 },
          receiptRef: 'task:work:task-auto#custody-receipt',
        },
      }),
    );
    recorder.record(
      baseInput({
        source: {
          subjectRef: 'message:thread-contract:silent',
          sourceRevision,
          evidenceRefs: ['message:thread-contract:silent'],
        },
        window: {
          kind: 'sampled_silent',
          openedAt: 700,
          closedAt: 800,
          sampling: { bucket: 'random', sampleRef: 'sample:random:2', policyVersion: 'f310.sampling.v1' },
        },
        candidate: { state: 'not_exposed' },
        policyDisposition: 'uninformed_silence',
        userDisposition: { state: 'not_observed' },
        custody: { state: 'no_task' },
        opportunityAssessment: {
          state: 'present',
          evidenceRefs: ['message:thread-contract:silent#calibration'],
        },
      }),
    );

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.state, 'valid');
    assert.deepEqual(snapshot.vector.denominator, {
      totalEpisodes: 3,
      actionWindows: 2,
      sampledSilentWindows: 1,
      randomSilentWindows: 1,
      riskTargetedSilentWindows: 0,
    });
    assert.equal(snapshot.vector.opportunity.sampledMissed, 1);
  });

  test('the contract carries no scalar score, case verdict, output quota, or prompt instruction', () => {
    const episode = new CustodyOpportunityEpisodeRecorder().record(baseInput());
    for (const forbidden of [
      { score: 0.92 },
      { caseVerdict: 'good_cat' },
      { outputQuota: 3 },
      { promptInstruction: 'offer more often' },
    ]) {
      assert.equal(custodyOpportunityEpisodeV1Schema.safeParse({ ...episode, ...forbidden }).success, false);
    }
    const snapshot = new CustodyOpportunityEpisodeRecorder().snapshot();
    assert.equal('score' in snapshot, false);
    assert.equal('prompt' in snapshot, false);
    assert.equal('verdict' in snapshot, false);
  });

  test('deterministic custody violations throw and invalidate the cohort instead of entering utility counts', () => {
    const recorder = new CustodyOpportunityEpisodeRecorder();
    recorder.record(baseInput());

    assert.throws(
      () =>
        recorder.record(
          baseInput({
            source: {
              subjectRef: 'message:thread-contract:invalid',
              sourceRevision,
              evidenceRefs: ['message:thread-contract:invalid'],
            },
            contractViolations: [
              {
                code: 'duplicate_admission',
                evidenceRef: 'task:work:task-contract#duplicate-admission',
              },
            ],
          }),
        ),
      CustodyOpportunityCohortInvalidError,
    );

    const snapshot = recorder.snapshot();
    assert.equal(snapshot.state, 'invalid');
    assert.equal('vector' in snapshot, false);
    assert.deepEqual(snapshot.contractViolations, [
      { code: 'duplicate_admission', evidenceRef: 'task:work:task-contract#duplicate-admission' },
    ]);
    assert.throws(() => recorder.record(baseInput()), CustodyOpportunityCohortInvalidError);
  });
});
