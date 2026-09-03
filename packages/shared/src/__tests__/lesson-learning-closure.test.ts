import { describe, expect, it } from 'vitest';
import { lessonConsumptionReplayV1Schema, lessonPromotionContractV1Schema } from '../types/lesson-learning-closure.js';

const promotionContract = {
  v: 1 as const,
  surfaceId: 'lessons-learned' as const,
  contractRevision: 'LessonPromotionContract.v1',
  canonical: {
    targetRef: 'docs/lessons-learned.md' as const,
    writer: 'reviewed_git_patch' as const,
    entryPattern: '^LL-\\d{3}$' as const,
  },
  dedupe: {
    keyRevision: 'LessonClaimFamily.v1' as const,
    keyFields: ['subsystem', 'failureMode', 'violatedInvariant'] as const,
    sameKeyAction: 'update_existing' as const,
    conflictAction: 'review_supersede_or_reject' as const,
    automaticSemanticMerge: 'forbidden' as const,
  },
  sources: [
    {
      kind: 'direct_edit' as const,
      role: 'canonical_candidate' as const,
      promotion: 'reviewed_canonical_patch' as const,
      sourceRef: 'docs/lessons-learned.md',
    },
    {
      kind: 'f102_marker' as const,
      role: 'candidate_only' as const,
      promotion: 'reviewed_canonical_patch' as const,
      sourceRef: 'packages/api/src/domains/memory/MaterializationService.ts',
    },
    {
      kind: 'f152_distillation' as const,
      role: 'downstream_only' as const,
      promotion: 'forbidden' as const,
      sourceRef: 'packages/api/src/domains/memory/distillation-service.ts',
    },
  ],
  nonAuthorities: [
    { kind: 'scanner' as const, capability: 'discovery_only' as const },
    { kind: 'index' as const, capability: 'discovery_only' as const },
    { kind: 'f200_consumed' as const, capability: 'observation_only' as const },
  ],
};

const lessonRevision = `sha256:${'d'.repeat(64)}`;
const predicateRevision = 'LessonPredicate.worktree-redis-sanctuary-preflight.v1';
const appliedRef = 'fixture://lesson-ll015-worktree-redis-guard#applied';
const outcomeRef = 'fixture://lesson-ll015-worktree-redis-guard#outcome';
const lessonReplay = {
  v: 1 as const,
  surfaceId: 'lessons-learned' as const,
  contractRevision: 'LessonConsumptionReplay.v1',
  predicate: {
    id: 'worktree_redis_sanctuary_preflight' as const,
    revision: predicateRevision,
    producer: 'start_dev_preflight' as const,
    eventKind: 'worktree_redis_sanctuary_preflight' as const,
    sourceRef: 'scripts/start-dev.sh#guard_runtime_redis_sanctuary',
    match: {
      deploymentClass: 'worktree' as const,
      resolvedRedisPort: 6399 as const,
      phase: 'before_storage_start' as const,
    },
  },
  source: {
    lessonRef: 'LL-015',
    canonicalRef: 'docs/lessons-learned.md' as const,
    lessonRevision,
  },
  receipt: {
    v: 0 as const,
    frameId: 'lesson-recall-frame-ll015-worktree-redis-guard',
    trigger: {
      kind: 'typed_event' as const,
      eventKind: 'worktree_redis_sanctuary_preflight',
      eventRef: 'fixture://lesson-ll015-worktree-redis-guard#event',
      eventRevision: `sha256:${'e'.repeat(64)}`,
    },
    predicateRevision,
    constructorRef: 'LessonLaneReplay.worktree_redis_sanctuary_preflight',
    constructorRevision: 'LessonConsumptionReplay.v1',
    sourceRefs: [
      {
        sourceRef: 'lesson://LL-015',
        sourceRevision: lessonRevision,
        authorityRef: 'docs/lessons-learned.md',
        eligibilityRef: `lesson-predicate://${predicateRevision}`,
      },
    ],
    asOf: 1_787_920_000_000,
    delivery: { state: 'presented' as const, refs: ['fixture://lesson-ll015-worktree-redis-guard#presented'] },
    application: { state: 'applied' as const, refs: [appliedRef] },
    outcome: { state: 'observed' as const, refs: [outcomeRef] },
    invalidation: { state: 'none_observed' as const, refs: [] },
    materialization: { mode: 'ephemeral' as const },
  },
  recurrenceOutcome: {
    kind: 'recurrence' as const,
    state: 'avoided' as const,
    applicationRef: appliedRef,
    outcomeRef,
    observationWindow: {
      kind: 'same_operation' as const,
      operationRef: 'start-dev-operation://fixture-ll015-1',
      startsAtRef: appliedRef,
      endsAtRef: 'fixture://lesson-ll015-worktree-redis-guard#process-exit',
    },
    matchingAttempts: 1,
    recurrentAttempts: 0,
    attributionCeiling: 'guarded_same_operation_association' as const,
    confounders: ['guard_enforcement'] as const,
    evidenceRefs: ['scripts/start-dev-profile-isolation.test.mjs#non-runtime-6399-blocked-before-spawn'],
    limitations:
      'Fixture proves only that the same guarded operation exits before a Redis child start; it does not prove future-task correctness or global lesson utility.',
  },
};

describe('Lesson learning closure contracts', () => {
  it('freezes one canonical promotion/dedupe boundary across direct edit, F102, and F152', () => {
    expect(lessonPromotionContractV1Schema.safeParse(promotionContract).success).toBe(true);
    expect(
      lessonPromotionContractV1Schema.safeParse({
        ...promotionContract,
        sources: promotionContract.sources.map((source) =>
          source.kind === 'f102_marker' ? { ...source, role: 'canonical_candidate' } : source,
        ),
      }).success,
    ).toBe(false);
    expect(
      lessonPromotionContractV1Schema.safeParse({
        ...promotionContract,
        sources: [...promotionContract.sources, promotionContract.sources[0]],
      }).success,
    ).toBe(false);
    expect(
      lessonPromotionContractV1Schema.safeParse({
        ...promotionContract,
        nonAuthorities: promotionContract.nonAuthorities.map((entry) =>
          entry.kind === 'scanner' ? { ...entry, capability: 'truth_authority' } : entry,
        ),
      }).success,
    ).toBe(false);
  });

  it('binds applied/dismissed receipts to exact predicate and Lesson revisions', () => {
    expect(lessonConsumptionReplayV1Schema.safeParse(lessonReplay).success).toBe(true);
    expect(
      lessonConsumptionReplayV1Schema.safeParse({
        ...lessonReplay,
        receipt: {
          ...lessonReplay.receipt,
          sourceRefs: [{ ...lessonReplay.receipt.sourceRefs[0], sourceRevision: `sha256:${'f'.repeat(64)}` }],
        },
      }).success,
    ).toBe(false);
    expect(
      lessonConsumptionReplayV1Schema.safeParse({
        ...lessonReplay,
        receipt: { ...lessonReplay.receipt, delivery: { state: 'eligible_only', refs: ['fixture://eligible'] } },
      }).success,
    ).toBe(false);
    expect(
      lessonConsumptionReplayV1Schema.safeParse({
        ...lessonReplay,
        receipt: {
          ...lessonReplay.receipt,
          materialization: {
            mode: 'persisted',
            viewRef: 'memory-derived-view://forbidden-lesson-body-projection',
            derivedViewContractRef: 'MemoryDerivedViewContract.v1',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('bounds recurrence outcomes to one operation and rejects body projection', () => {
    expect(
      lessonConsumptionReplayV1Schema.safeParse({
        ...lessonReplay,
        recurrenceOutcome: {
          ...lessonReplay.recurrenceOutcome,
          observationWindow: { ...lessonReplay.recurrenceOutcome.observationWindow, kind: 'future_tasks' },
        },
      }).success,
    ).toBe(false);
    expect(
      lessonConsumptionReplayV1Schema.safeParse({
        ...lessonReplay,
        recurrenceOutcome: { ...lessonReplay.recurrenceOutcome, recurrentAttempts: 1 },
      }).success,
    ).toBe(false);
    expect(
      lessonConsumptionReplayV1Schema.safeParse({ ...lessonReplay, rawLessonBody: 'do not project me' }).success,
    ).toBe(false);
  });
});
