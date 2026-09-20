import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_ID,
  DEFAULT_REJECTION_REASON,
  HUMAN_JOURNEY_STEPS,
  type JourneyScenario,
  type JourneyScene,
  journeyFor,
  lifelineFor,
} from '../journey-model';

function scene(scenario: JourneyScenario, id: JourneyScene['id']): JourneyScene {
  const found = journeyFor(scenario).find((entry) => entry.id === id);
  if (!found) throw new Error(`missing ${scenario} scene ${id}`);
  return found;
}

describe('F257 operator journey contract', () => {
  it.each(['applied', 'rejected'] as const)('uses the same five human steps for the %s path', (scenario) => {
    const journey = journeyFor(scenario);
    expect(journey.map((entry) => entry.stepLabel)).toEqual(HUMAN_JOURNEY_STEPS);
    expect(journey).toHaveLength(5);
  });

  it.each([
    'applied',
    'rejected',
  ] as const)('keeps engineering events and experiments out of the %s journey', (scenario) => {
    const journey = journeyFor(scenario);
    const visibleCopy = journey
      .flatMap((entry) => [entry.stepLabel, entry.eyebrow, entry.title, entry.explanation])
      .join(' ');
    expect(visibleCopy).not.toMatch(
      /TraceAnnotationCommitted|ObjectiveJudgmentCommitted|GovernanceCandidateOpened|Override|PatchTrial|中断|恢复|启动试验/,
    );
    expect(journey.every((entry) => !('patchTrial' in entry))).toBe(true);
  });

  it('makes the evaluation metric, rule, frozen window, source and conclusion explicit', () => {
    const evaluation = scene('applied', 'evaluation-complete');
    expect(evaluation.evaluationEvidence).toMatchObject({
      snapshotId: 'snapshot-s13-schema-failure',
      contentRef: 'S13@v1',
      sourceKind: 'InjectionTrace summary',
      sourceRefs: ['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'],
      window: { start: expect.any(Number), end: expect.any(Number), frozen: true },
      verdict: 'retire-candidate',
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          rule: 'counter-zero',
          measurement: 'count = 3',
          decision: 'breach',
        },
      ],
    });
  });

  it('makes governance automatic and keeps the only click at the approval card', () => {
    const suggestion = scene('applied', 'governance-suggested');
    expect(suggestion.transitionOwner).toBe('governance-worker');
    expect(suggestion.candidate).toMatchObject({
      candidateId: CANDIDATE_ID,
      status: 'proposed',
      decisionMode: 'apply-reject',
      proposedAction: {
        mechanism: 'override-content',
        createsVersion: 2,
        governanceBridge: 'prototype-only',
      },
    });
    expect(suggestion.operatorActionRequired).toBe('apply-or-reject');
  });

  it('creates v2 only when the operator applies a content change', () => {
    const applied = scene('applied', 'operator-applied');
    expect(applied.candidate).toMatchObject({ status: 'approved', operatorDecisionCount: 1 });
    expect(applied.versionTransition).toEqual({
      fromVersion: 1,
      toVersion: 2,
      action: 'setContentOverride',
      primitiveSupport: 'available',
      governanceBridge: 'prototype-only',
    });

    const nextRound = scene('applied', 'next-round');
    expect(nextRound).toMatchObject({ activeVersion: 2, roundInUnit: 1, activeStage: 'tracing', terminal: true });
    expect(nextRound.versionTransition?.toVersion).toBe(2);
    expect(lifelineFor(nextRound)).toEqual([
      {
        version: 1,
        isActive: false,
        rounds: [{ round: 1, isCurrent: false, currentStage: null, governanceOutcome: 'approved' }],
      },
      {
        version: 2,
        isActive: true,
        rounds: [{ round: 1, isCurrent: true, currentStage: 'tracing', governanceOutcome: null }],
      },
    ]);
  });

  it('keeps reject inside v1, persists the reason, and starts another round without a new version', () => {
    const rejectedJourney = journeyFor('rejected', DEFAULT_REJECTION_REASON);
    const rejected = rejectedJourney.find((entry) => entry.id === 'operator-rejected');
    expect(rejected?.candidate).toMatchObject({
      status: 'rejected',
      operatorDecisionCount: 1,
      decisionNote: DEFAULT_REJECTION_REASON,
    });
    expect(rejected?.versionTransition).toEqual({
      fromVersion: 1,
      toVersion: null,
      action: 'continue-observe',
      primitiveSupport: 'not-needed',
      governanceBridge: 'not-needed',
    });

    const nextRound = rejectedJourney.at(-1);
    expect(nextRound).toMatchObject({
      id: 'next-round',
      activeVersion: 1,
      roundInUnit: 2,
      activeStage: 'tracing',
      nextEvaluationContext: {
        rejectionNote: DEFAULT_REJECTION_REASON,
        persistence: 'candidate-approval-note',
        evaluatorBridge: 'prototype-only',
      },
      terminal: true,
    });
    expect(lifelineFor(nextRound as JourneyScene)).toEqual([
      {
        version: 1,
        isActive: true,
        rounds: [
          { round: 1, isCurrent: false, currentStage: null, governanceOutcome: 'rejected' },
          { round: 2, isCurrent: true, currentStage: 'tracing', governanceOutcome: null },
        ],
      },
    ]);
  });
});
