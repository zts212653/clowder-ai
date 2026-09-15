import { type EvolutionProgramOriginV1, type EvolutionProgramV1, evolutionProgramTitle } from '@cat-cafe/shared';

export function surfaceFor(
  program: Pick<EvolutionProgramV1, 'programId' | 'displayName'>,
  origin?: EvolutionProgramOriginV1,
) {
  const { programId } = program;
  return {
    id: `evolution-program:${programId}`,
    type: 'evolution-program',
    renderer: 'evolution-program',
    title: evolutionProgramTitle(program, origin),
    context: '能力进化 · 项目判断与更改历史',
    objectRef: { kind: 'evolution-program', id: programId },
    ownerStateRef: { owner: 'f311-capability-evolution-control', key: programId },
    resultTargetRef: { owner: 'f311-capability-evolution-control', key: programId },
    capabilities: {
      split: true,
      sidecar: true,
      pin: true,
      mainAreaAttention: true,
      closePolicy: 'detach-host',
      restorePolicy: 'descriptor',
    },
  } as const;
}
