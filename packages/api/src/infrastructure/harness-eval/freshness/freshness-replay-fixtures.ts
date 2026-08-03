import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FreshnessReplayFacts, FreshnessReplaySample, FreshnessReplayScenario } from './freshness-replay-types.js';

export const FRESHNESS_AC_E9_FIXTURE_IDS = [
  'original-double-message-dogfood',
  'existing-coverage-without-closure',
  'crash-cancel',
  'continuous-new-messages',
  'multi-target',
  'parallel-same-batch',
  'attempt-recheck-budget',
  'connector-blocked',
] as const;

export const FRESHNESS_AC_E9_SCENARIOS = [
  'original_double_message_dogfood',
  'existing_coverage_without_closure',
  'crash_cancel',
  'continuous_new_messages',
  'multi_target',
  'parallel_same_batch',
  'attempt_recheck_budget',
  'connector_blocked',
] as const satisfies readonly FreshnessReplayScenario[];

export type FreshnessReplayFixtureId = (typeof FRESHNESS_AC_E9_FIXTURE_IDS)[number];

const fixtureIdSet = new Set<string>(FRESHNESS_AC_E9_FIXTURE_IDS);
const scenarioSchema = z.enum(FRESHNESS_AC_E9_SCENARIOS);
const nonNegativeInt = z.number().int().nonnegative();
const factsSchema = z.object({
  responsibilityCount: nonNegativeInt,
  custodyCount: nonNegativeInt,
  formalFinalCount: nonNegativeInt,
  formalFinalLimit: nonNegativeInt,
  knownStaleFinalCount: nonNegativeInt,
  targetCount: nonNegativeInt,
  accountedTargetCount: nonNegativeInt,
  sameBatchSiblingWakeCount: nonNegativeInt,
  automaticAttemptCount: nonNegativeInt,
  automaticAttemptLimit: nonNegativeInt.nullable(),
  commitRecheckCount: nonNegativeInt,
  commitRecheckLimit: nonNegativeInt.nullable(),
  terminalEvidenceComplete: z.boolean(),
});
const fixtureSchema = z.object({
  id: z.string().min(1),
  scenario: scenarioSchema,
  threadId: z.string().min(1),
  catIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  facts: factsSchema,
});

export function isFreshnessReplayFixtureId(value: string): value is FreshnessReplayFixtureId {
  return fixtureIdSet.has(value);
}

export function loadFreshnessReplayFixture(input: {
  fixtureRoot: string;
  fixtureId: FreshnessReplayFixtureId;
  occurredAt: number;
}): FreshnessReplaySample {
  const path = join(input.fixtureRoot, `${input.fixtureId}.json`);
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (fixture.id !== input.fixtureId) {
    throw new Error(`freshness_fixture_id_mismatch: expected=${input.fixtureId} actual=${fixture.id}`);
  }
  return {
    id: `fixture:${fixture.id}`,
    scenario: fixture.scenario,
    source: 'fixture',
    occurredAt: input.occurredAt,
    threadId: fixture.threadId,
    catIds: [...fixture.catIds],
    traceRef: `trace:f254-ac-e9/${fixture.id}`,
    evidenceRefs: [...fixture.evidenceRefs],
    facts: fixture.facts as FreshnessReplayFacts,
    attentionReasons: [],
  };
}
