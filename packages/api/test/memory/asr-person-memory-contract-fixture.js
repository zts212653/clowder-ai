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

export const artifact = {
  text: 'speaker_1: private transcript\nspeaker_2: more private transcript',
  provenance: {
    sourceHandle: 'lark://minutes/meeting-1',
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
  },
};

export async function contractTrialFixture(options = {}) {
  const { buildAsrPersonMemoryDynamicScenes } = await import(
    '../../dist/domains/signal-intake/AsrPersonMemorySceneBuilder.js'
  );
  const { AsrPersonMemoryContractTrial, MemoryContractTrialTraceBuffer } = await import(
    '../../dist/domains/memory/people/AsrPersonMemoryContractTrial.js'
  );
  const scene = buildAsrPersonMemoryDynamicScenes({
    intake,
    artifact,
    threadId: 'thread-1',
    consumerCatId: 'codex-sol',
    now: 1_200,
  })[0];
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
