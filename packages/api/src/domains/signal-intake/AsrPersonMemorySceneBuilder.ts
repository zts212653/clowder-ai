import { createHash } from 'node:crypto';
import type { CatId, MeetingIntake } from '@cat-cafe/shared';
import {
  ASR_PERSON_MEMORY_REFLEX_ENTRY_V1,
  type AsrPersonMemoryDynamicSceneEntryV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import type { MeetingArtifact } from './MeetingIntakeActionService.js';

export interface BuildAsrPersonMemoryDynamicScenesInput {
  readonly intake: Pick<MeetingIntake, 'intakeId' | 'ownerId' | 'judgmentState' | 'choices' | 'updatedAt'>;
  readonly artifact: Pick<MeetingArtifact, 'text' | 'provenance'>;
  readonly threadId: string;
  readonly consumerCatId: CatId;
  readonly now: number;
}

function digest(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export function buildAsrPersonMemoryDynamicScenes(
  input: BuildAsrPersonMemoryDynamicScenesInput,
): AsrPersonMemoryDynamicSceneEntryV1[] {
  const speakerMap = input.intake.choices.speakerMap ?? {};
  const byteLength = Buffer.byteLength(input.artifact.text, 'utf8');
  if (
    input.intake.judgmentState !== 'confirmed' ||
    input.artifact.provenance.trust !== 'untrusted_external' ||
    input.artifact.provenance.instructionPolicy !== 'data_only' ||
    byteLength === 0
  ) {
    return [];
  }
  const sourceRevision = `sha256:${digest(input.artifact.text)}`;
  const observedAt = Math.min(input.intake.updatedAt, input.now);
  const normalizedSpeakerMap = Object.entries(speakerMap)
    .map(([externalSpeakerId, label]) => [externalSpeakerId.trim(), label.trim()] as const)
    .filter(([externalSpeakerId, label]) => externalSpeakerId.length > 0 && label.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  if (normalizedSpeakerMap.length === 0 || normalizedSpeakerMap.length > 8) return [];
  const attributionRevision = `sha256:${digest(JSON.stringify(normalizedSpeakerMap))}`;
  const lineageDigest = digest(
    'asr-person-memory-lineage-v1',
    input.intake.ownerId,
    input.intake.intakeId,
    input.artifact.provenance.sourceHandle,
    sourceRevision,
    attributionRevision,
    String(ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.version),
  ).slice(0, 32);
  const dedupeLineage = `write_lineage_${lineageDigest}`;
  const scene = {
    v: 1 as const,
    kind: 'memory_write_opportunity' as const,
    surface: 'dynamic_context' as const,
    opportunity: {
      v: 1 as const,
      opportunityId: writeOpportunityGenerationId(dedupeLineage, 1),
      reflexId: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.reflexId,
      reflexVersion: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.version,
      generation: 1,
      producer: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.producer,
      consumer: { kind: 'cat' as const, catId: input.consumerCatId },
      scope: { ownerUserId: input.intake.ownerId, threadId: input.threadId },
      observedAt,
      eligibleAt: input.now,
      expiresAt: input.now + ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.expiryMs,
      sourceCoordinates: normalizedSpeakerMap.map(([externalSpeakerId, label]) => ({
        kind: 'asr_transcript_segment' as const,
        artifactId: input.intake.intakeId,
        sourceHandle: input.artifact.provenance.sourceHandle,
        sourceRevision,
        segment: { unit: 'utf8_byte' as const, start: 0, end: byteLength },
        speaker: {
          externalSpeakerId,
          label,
          attributionRevision,
          attributionCeiling: 'owner_confirmed_mapping' as const,
        },
      })),
      epistemicCeiling: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.epistemicCeiling,
      destination: {
        lane: 'person_memory' as const,
        proposalContract: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.immediateTargetByLane.person_memory,
      },
      dedupeLineage,
      rearmPredicate: ASR_PERSON_MEMORY_REFLEX_ENTRY_V1.rearmPredicate,
    },
  };
  return [asrPersonMemoryDynamicSceneEntryV1Schema.parse(scene)];
}
