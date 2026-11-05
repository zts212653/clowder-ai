export const intake = {
  intakeId: 'meeting-intake-1',
  ownerId: 'owner-1',
  choices: {
    speakerMap: { speaker_2: 'Bao', speaker_1: 'Alden' },
    context: 'Quarterly planning',
    destinationHandle: 'host:private-thread:thread-1',
    outputs: ['minutes'],
  },
  judgmentState: 'confirmed',
  updatedAt: 1_000,
};

export const artifactText = 'speaker_1: private transcript\nspeaker_2: more private transcript';
export const artifact = {
  contentType: 'text/plain',
  resourceRef: `meeting-artifact://intakes/meeting-intake-1?revision=sha256:${'b'.repeat(64)}`,
  sourceHandle: 'lark://minutes/meeting-1',
  sourceRevision: `sha256:${'b'.repeat(64)}`,
  byteLength: Buffer.byteLength(artifactText, 'utf8'),
  trust: 'untrusted_external',
  instructionPolicy: 'data_only',
};

export async function memorySceneFixture({ now = 1_200, consumerCatId = 'codex-sol', threadId = 'thread-1' } = {}) {
  const {
    ASR_PERSON_MEMORY_REFLEX_ENTRY_V1: reflex,
    asrPersonMemoryDynamicSceneEntryV1Schema,
    writeOpportunityGenerationId,
  } = await import('@cat-cafe/shared');
  const dedupeLineage = `write_lineage_${'a'.repeat(32)}`;
  return asrPersonMemoryDynamicSceneEntryV1Schema.parse({
    v: 1,
    kind: 'memory_write_opportunity',
    surface: 'dynamic_context',
    opportunity: {
      v: 1,
      opportunityId: writeOpportunityGenerationId(dedupeLineage, 1),
      reflexId: reflex.reflexId,
      reflexVersion: reflex.version,
      generation: 1,
      producer: reflex.producer,
      consumer: { kind: 'cat', catId: consumerCatId },
      scope: { ownerUserId: 'owner-1', threadId },
      observedAt: now - 10,
      eligibleAt: now,
      expiresAt: now + reflex.expiryMs,
      sourceCoordinates: ['speaker_1', 'speaker_2'].map((externalSpeakerId, index) => ({
        kind: 'asr_transcript_segment',
        artifactId: intake.intakeId,
        sourceHandle: artifact.sourceHandle,
        sourceRevision: artifact.sourceRevision,
        segment: { unit: 'utf8_byte', start: 0, end: artifact.byteLength },
        speaker: {
          externalSpeakerId,
          label: index === 0 ? 'Alden' : 'Bao',
          attributionRevision: `sha256:${'c'.repeat(64)}`,
          attributionCeiling: 'owner_confirmed_mapping',
        },
      })),
      epistemicCeiling: reflex.epistemicCeiling,
      destination: { lane: 'person_memory', proposalContract: reflex.immediateTargetByLane.person_memory },
      dedupeLineage,
      rearmPredicate: reflex.rearmPredicate,
    },
  });
}

export async function contractTrialFixture(options = {}) {
  const { AsrPersonMemoryContractTrial, MemoryContractTrialTraceBuffer } = await import(
    '../../dist/domains/memory/people/AsrPersonMemoryContractTrial.js'
  );
  const scene = await memorySceneFixture();
  const trace = new MemoryContractTrialTraceBuffer();
  const defaultVerifier = (evidence) =>
    evidence?.kind === 'f296_opportunity_presentation_v1'
      ? { status: 'verified', value: evidence }
      : { status: 'invalid' };
  const trial = new AsrPersonMemoryContractTrial({
    trace,
    presentationVerifier: Object.hasOwn(options, 'presentationVerifier')
      ? options.presentationVerifier
      : defaultVerifier,
  });
  return { scene, trace, trial };
}
