import { type EvolutionExplorationRequestV1, refIdentity } from '@cat-cafe/shared';
import { failedExploration, resolveExplorationProjection } from '../../read-model/program-exploration.js';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import { PROGRAM_ADAPTER_CAPABILITIES, type ProgramAdapter } from '../program-adapter-registry.js';
import { archiveDigest, archiveRef } from './archive-reader.js';
import { createCortexExplorationBindings } from './cortex-publication.js';
import { createMicroduckExplorationBindings } from './publication.js';

/** Accepted Program-to-publication relationship; no owner reassignment or execution authority. */
export const DUCK_PUBLIC_SOURCE_SCOPE = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-program:352afab60afb6263b8386eaed12dba03' },
  objectRef: {
    ownerFeatureId: 'F311',
    ownerStateRef:
      'capability:%E7%8C%AB%E7%8C%AB%E5%B8%A6%E9%B8%AD%E9%B8%AD%E5%8D%8F%E5%90%8C%E8%B8%A2%E7%90%83%E8%B5%9B',
  },
} as const;
const inScope = (input: Pick<EvolutionExplorationRequestV1, 'programRef' | 'objectRef'>) =>
  refIdentity(input.programRef) === refIdentity(DUCK_PUBLIC_SOURCE_SCOPE.programRef) &&
  refIdentity(input.objectRef) === refIdentity(DUCK_PUBLIC_SOURCE_SCOPE.objectRef);

export function createDuckCapabilityPublicAdapter(options: MicroduckLocalEvidenceOptions): ProgramAdapter {
  const football = createMicroduckExplorationBindings({ ...options, sourceScope: DUCK_PUBLIC_SOURCE_SCOPE });
  const cortex = createCortexExplorationBindings(options);
  const blocked = () => ({ status: 'blocked' as const, code: 'owner_route_unavailable' });
  return {
    descriptor: {
      schemaVersion: 1,
      adapterId: 'duck-capability-public-archive-v1',
      adapterOwnerRef: { ownerFeatureId: 'F311', ownerStateRef: 'adapter:duck-public-source-binding', version: '1' },
      targetOwnerFeatureId: DUCK_PUBLIC_SOURCE_SCOPE.objectRef.ownerFeatureId,
      targetStateRefPrefix: DUCK_PUBLIC_SOURCE_SCOPE.objectRef.ownerStateRef,
      capabilities: PROGRAM_ADAPTER_CAPABILITIES,
    },
    observe: blocked,
    permission: blocked,
    mutate: blocked,
    verify: blocked,
    writeback: blocked,
    freshOutcome: blocked,
    rollback: blocked,
    async explorationReview(input) {
      if (!inScope(input)) return failedExploration(input, 'invalid', 'public_archive_consumer_scope_mismatch');
      const reads = await Promise.all([football.explorationReview(input), cortex.explorationReview(input)]);
      const resolved = reads.filter((read) => read.status === 'resolved');
      const blockers = reads.flatMap((read) => read.blockers);
      if (!resolved.length)
        return failedExploration(
          input,
          reads.some((read) => read.status === 'invalid') ? 'invalid' : 'unavailable',
          'duck_public_sources_unavailable',
          blockers,
        );
      return resolveExplorationProjection(input, {
        schemaVersion: 1,
        status: 'resolved',
        programRef: input.programRef,
        objectRef: input.objectRef,
        readAt: new Date().toISOString(),
        sourceRef: archiveRef('duck-capability-publications', archiveDigest(resolved.map((read) => read.sourceRef))),
        nodes: resolved.flatMap((read) => read.nodes),
        experiments: resolved.flatMap((read) => read.experiments),
        details: resolved.flatMap((read) => read.details),
        blockers,
      });
    },
    async explorationMedia(input) {
      if (!inScope(input)) return { status: 'invalid', reason: '请求不属于已绑定的项目与目标。' };
      return input.experimentRef.ownerStateRef.startsWith('cortex-run:')
        ? cortex.explorationMedia(input)
        : football.explorationMedia(input);
    },
  };
}
