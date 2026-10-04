import type { EvolutionExplorationRequestV1 } from '@cat-cafe/shared';
import type { ProgramAdapterRegistry } from '../adapters/program-adapter-registry.js';
import type { EvolutionProgramService } from '../program-service.js';
import { unavailableExploration } from './program-exploration.js';

export class EvolutionExplorationReadError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super('exploration_owner_read_failed');
  }
}

/** A verified caller identity is supplied by the transport; Program ownership always comes from F311. */
export async function resolveAuthorizedExplorationProgram(
  options: { service: Pick<EvolutionProgramService, 'get'>; adapterRegistry?: ProgramAdapterRegistry },
  programId: string,
  ownerUserId: string,
) {
  const projection = await options.service.get(programId);
  if (!ownerUserId || projection.program.workspaceId !== 'user:' + ownerUserId)
    throw new EvolutionExplorationReadError(404, { error: 'not_found' });
  const input: EvolutionExplorationRequestV1 = {
    programRef: { ownerFeatureId: 'F311', ownerStateRef: programId },
    objectRef: projection.program.objectRef,
  };
  const resolution = options.adapterRegistry?.resolve(input.objectRef);
  if (resolution?.status !== 'resolved')
    throw new EvolutionExplorationReadError(422, unavailableExploration(input, 'owner_exploration_unavailable'));
  return { input, adapter: resolution.adapter };
}
