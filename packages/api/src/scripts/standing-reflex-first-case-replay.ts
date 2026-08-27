import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCatId,
  type MeetingArtifactDescriptor,
  type MeetingIntake,
  type StandingReflexReplayContractV1,
} from '@cat-cafe/shared';
import {
  AsrPersonMemoryContractTrial,
  type OpportunityPresentationVerifier,
} from '../domains/memory/people/AsrPersonMemoryContractTrial.js';
import { buildAsrPersonMemoryDynamicScenes } from '../domains/signal-intake/AsrPersonMemorySceneBuilder.js';
import {
  buildStandingReflexFirstCaseContract,
  type StandingReflexFirstCaseContractProjection,
} from './standing-reflex-first-case-contract.js';

const OWNER_USER_ID = 'standing-reflex-replay-owner';
const CONSUMER_CAT_ID = createCatId('codex-sol');

type HistoricalSource =
  | {
      readonly kind: 'owner_explicit_event';
      readonly threadId: string;
      readonly sourceMessageId: string;
    }
  | {
      readonly kind: 'owner_confirmed_asr_transcript';
      readonly threadId: string;
      readonly sourceMessageId: string;
    };

interface HistoricalFixture {
  readonly id: string;
  readonly source: HistoricalSource;
  readonly replayPath: 'exclude_non_asr' | 'propose' | 'defer_then_propose';
  readonly observedAt: number;
}

export interface StandingReflexFirstCaseReplayCaseResult {
  readonly id: string;
  readonly source: Pick<HistoricalSource, 'kind' | 'threadId' | 'sourceMessageId'>;
  readonly status: 'excluded_non_asr_source' | 'contract_replay_passed';
  readonly steps: readonly string[];
  readonly generations: readonly number[];
  readonly lineagePreserved: boolean;
  readonly observedAt: number;
}

export type StandingReflexFirstCaseReplayResult = StandingReflexReplayContractV1 & {
  readonly status: 'contract_passed' | 'constraint_violation';
  readonly cases: readonly StandingReflexFirstCaseReplayCaseResult[];
  readonly hardFailures: readonly string[];
  readonly shadowHealth: StandingReflexFirstCaseContractProjection['shadowHealth'];
  readonly replayComparison: StandingReflexFirstCaseContractProjection['replayComparison'];
};

/**
 * Historical source map, not a payload archive.
 *
 * The July source is deliberately retained as a negative boundary: it is an owner-authored event
 * statement, not an ASR artifact. Treating all three historical observations as "three ASRs" would
 * forge the producer kind. The other two refs are owner-confirmed ASR attachments. No transcript
 * body, speaker map, or person name is checked into the fixture.
 */
const HISTORICAL_FIXTURES: readonly HistoricalFixture[] = [
  {
    id: 'owner-explicit-phone-event',
    source: {
      kind: 'owner_explicit_event',
      threadId: 'thread_mrxqq9iyx833nm56',
      sourceMessageId: '0001785058845897-000213-8cb7a3dd',
    },
    replayPath: 'exclude_non_asr',
    observedAt: Date.parse('2026-07-23T23:00:00-07:00'),
  },
  {
    id: 'asr-product-grounding',
    source: {
      kind: 'owner_confirmed_asr_transcript',
      threadId: 'thread_ms1uaq5wjwvhcue0',
      sourceMessageId: '0001785861514468-000004-319d33c1',
    },
    replayPath: 'defer_then_propose',
    observedAt: Date.parse('2026-08-04T12:00:00Z'),
  },
  {
    id: 'asr-hiring-method',
    source: {
      kind: 'owner_confirmed_asr_transcript',
      threadId: 'thread_ms1uaq5wjwvhcue0',
      sourceMessageId: '0001786030137105-000032-3d07b980',
    },
    replayPath: 'propose',
    observedAt: Date.parse('2026-08-06T12:00:00Z'),
  },
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toOpaqueSource(source: HistoricalSource): StandingReflexFirstCaseReplayCaseResult['source'] {
  return {
    kind: source.kind,
    threadId: source.threadId,
    sourceMessageId: source.sourceMessageId,
  };
}

const verifyFixturePresentation: OpportunityPresentationVerifier = (candidate) => {
  if (!candidate || typeof candidate !== 'object') return { status: 'invalid' };
  const value = candidate as Record<string, unknown>;
  if (
    value.kind !== 'standing_reflex_first_case_delivery' ||
    value.outcome !== 'delivered' ||
    typeof value.continuityDispositionRef !== 'string' ||
    typeof value.generationId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.generationId) ||
    typeof value.evidenceRef !== 'string' ||
    typeof value.occurredAt !== 'number'
  ) {
    return { status: 'invalid' };
  }
  return {
    status: 'verified',
    value: {
      outcome: 'delivered',
      continuityDispositionRef: value.continuityDispositionRef,
      generationId: value.generationId,
      evidenceRef: value.evidenceRef,
      occurredAt: value.occurredAt,
    },
  };
};

function buildScene(
  fixture: HistoricalFixture & { source: Extract<HistoricalSource, { kind: 'owner_confirmed_asr_transcript' }> },
) {
  const sourceRef = `${fixture.source.threadId}/${fixture.source.sourceMessageId}`;
  const revision: `sha256:${string}` = `sha256:${sha256(sourceRef)}`;
  const artifact: MeetingArtifactDescriptor = {
    contentType: 'text/plain',
    resourceRef: `memory-replay://standing-reflex/${fixture.id}?revision=${revision}`,
    sourceHandle: `thread-message://${sourceRef}`,
    sourceRevision: revision,
    // The producer only needs a non-empty bounded coordinate. Payload is intentionally absent.
    byteLength: 1,
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
  };
  const intake: Pick<MeetingIntake, 'intakeId' | 'ownerId' | 'judgmentState' | 'choices' | 'updatedAt'> = {
    intakeId: `standing-reflex-replay-${fixture.id}`,
    ownerId: OWNER_USER_ID,
    judgmentState: 'confirmed',
    choices: {
      // The historical fixture stores only source coordinates. This generic adapter-only map
      // exercises the ASR contract without preserving a real speaker identity map.
      speakerMap: { source_speaker: 'source_subject' },
      context: 'historical contract replay',
      destinationHandle: `host:private-thread:${fixture.source.threadId}`,
      outputs: ['minutes'],
    },
    updatedAt: fixture.observedAt,
  };
  const scenes = buildAsrPersonMemoryDynamicScenes({
    intake,
    artifact,
    threadId: fixture.source.threadId,
    consumerCatId: CONSUMER_CAT_ID,
    now: fixture.observedAt + 1,
  });
  if (scenes.length !== 1) throw new Error(`${fixture.id}: expected exactly one ASR scene`);
  return scenes[0];
}

function deliver(
  trial: AsrPersonMemoryContractTrial,
  state: Parameters<AsrPersonMemoryContractTrial['recordPresentation']>[0],
  occurredAt: number,
) {
  const delivered = trial.recordPresentation(state, {
    kind: 'standing_reflex_first_case_delivery',
    outcome: 'delivered',
    continuityDispositionRef: 'fixture:codex-exec-json',
    generationId: `sha256:${sha256(`${state.scene.opportunity.opportunityId}:generation`)}`,
    evidenceRef: `fixture-delivery:${state.scene.opportunity.opportunityId}`,
    occurredAt,
  });
  if (delivered.status !== 'transitioned') throw new Error(`delivery rejected: ${delivered.reason}`);
  return delivered.state;
}

function propose(
  trial: AsrPersonMemoryContractTrial,
  state: Parameters<AsrPersonMemoryContractTrial['recordDisposition']>[0],
  recordedAt: number,
) {
  const opportunity = state.scene.opportunity;
  const proposed = trial.recordDisposition(state, {
    v: 1,
    opportunityId: opportunity.opportunityId,
    generation: opportunity.generation,
    disposition: 'propose',
    recordedAt,
    destination: {
      proposalContract: 'F276.CaptureCandidate.v1',
      proposalId: `person_candidate_${sha256(opportunity.opportunityId).slice(0, 32)}`,
    },
  });
  if (proposed.status !== 'transitioned') throw new Error(`proposal rejected: ${proposed.reason}`);
}

function replayAsrFixture(
  fixture: HistoricalFixture & { source: Extract<HistoricalSource, { kind: 'owner_confirmed_asr_transcript' }> },
): StandingReflexFirstCaseReplayCaseResult {
  const scene = buildScene(fixture);
  const trial = new AsrPersonMemoryContractTrial({ presentationVerifier: verifyFixturePresentation });
  const steps = ['asr_scene_built'];
  const generations = [scene.opportunity.generation];
  const admitted = trial.admit(scene, {
    now: scene.opportunity.eligibleAt,
    ownerUserId: OWNER_USER_ID,
    threadId: fixture.source.threadId,
    consumerCatId: CONSUMER_CAT_ID,
    predicateRevision: 1,
    aclAllowed: true,
    terminalGenerationKeys: new Set(),
  });
  if (admitted.status !== 'eligible') throw new Error(`${fixture.id}: initial admission failed`);
  const firstDelivered = deliver(trial, admitted, scene.opportunity.eligibleAt + 1);
  steps.push('generation_1_delivered');

  if (fixture.replayPath === 'defer_then_propose') {
    const deferred = trial.recordDisposition(firstDelivered, {
      v: 1,
      opportunityId: scene.opportunity.opportunityId,
      generation: scene.opportunity.generation,
      disposition: 'defer',
      recordedAt: scene.opportunity.eligibleAt + 2,
      destination: {
        receiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1',
        receiptId: `deferred_person_${sha256(scene.opportunity.opportunityId).slice(0, 32)}`,
      },
    });
    if (deferred.status !== 'transitioned' || !deferred.receipt) {
      throw new Error(`${fixture.id}: defer failed`);
    }
    steps.push('generation_1_deferred');
    const reentered = trial.reenterDeferred(deferred.receipt, scene.opportunity, {
      now: deferred.receipt.eligibleAt,
      reason: 'eligible_owner_context',
      aclAllowed: true,
      terminalGenerationKeys: new Set([`${scene.opportunity.dedupeLineage}:1`]),
    });
    if (reentered.status !== 'reentered') throw new Error(`${fixture.id}: re-entry failed: ${reentered.reason}`);
    steps.push('eligible_context_reentry');
    generations.push(reentered.scene.opportunity.generation);
    const secondDelivered = deliver(
      trial,
      { status: 'eligible', scene: reentered.scene },
      reentered.scene.opportunity.eligibleAt + 1,
    );
    steps.push('generation_2_delivered');
    propose(trial, secondDelivered, reentered.scene.opportunity.eligibleAt + 2);
    steps.push('generation_2_proposed');
    return {
      id: fixture.id,
      source: toOpaqueSource(fixture.source),
      status: 'contract_replay_passed',
      steps,
      generations,
      lineagePreserved: reentered.scene.opportunity.dedupeLineage === scene.opportunity.dedupeLineage,
      observedAt: fixture.observedAt,
    };
  }

  propose(trial, firstDelivered, scene.opportunity.eligibleAt + 2);
  steps.push('generation_1_proposed');
  return {
    id: fixture.id,
    source: toOpaqueSource(fixture.source),
    status: 'contract_replay_passed',
    steps,
    generations,
    lineagePreserved: true,
    observedAt: fixture.observedAt,
  };
}

export function runStandingReflexFirstCaseReplay(): StandingReflexFirstCaseReplayResult {
  const cases = HISTORICAL_FIXTURES.map((fixture): StandingReflexFirstCaseReplayCaseResult => {
    if (fixture.source.kind === 'owner_explicit_event') {
      return {
        id: fixture.id,
        source: toOpaqueSource(fixture.source),
        status: 'excluded_non_asr_source',
        steps: ['source_kind_checked', 'excluded_from_asr_replay'],
        generations: [],
        lineagePreserved: true,
        observedAt: fixture.observedAt,
      };
    }
    return replayAsrFixture({ ...fixture, source: fixture.source });
  });
  const hardFailures = cases.flatMap((item) => [
    ...(item.status === 'contract_replay_passed' && item.generations.length === 0 ? [`${item.id}:no_generation`] : []),
    ...(item.id === 'asr-product-grounding' && !item.lineagePreserved ? [`${item.id}:lineage_drift`] : []),
  ]);
  const projection = buildStandingReflexFirstCaseContract(cases);
  return {
    ...projection.replay,
    status: hardFailures.length === 0 ? 'contract_passed' : 'constraint_violation',
    cases,
    hardFailures,
    shadowHealth: projection.shadowHealth,
    replayComparison: projection.replayComparison,
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  console.log(JSON.stringify(runStandingReflexFirstCaseReplay(), null, 2));
}
