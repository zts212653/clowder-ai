import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { TasteRepository } from '../../taste/services/TasteRepository.js';
import type { IEvidenceStore } from '../interfaces.js';
import type { PersonMemoryRecallService } from '../people/PersonMemoryRecallService.js';
import type { MemoryCueDrillHandleService } from './MemoryCueDrillHandleService.js';
import type { MemoryCueEpisodeStore } from './MemoryCueEpisodeStore.js';
import { MemoryCueInvocationPromptService } from './MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from './MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from './MemoryCueResolverRegistry.js';
import type { MemoryCueSourceReader } from './MemoryCueSourceReader.js';
import { OperationalPrecedentCueResolver } from './resolvers/OperationalPrecedentCueResolver.js';
import { PersonEntityCueResolver } from './resolvers/PersonEntityCueResolver.js';
import { ProfileCueResolver } from './resolvers/ProfileCueResolver.js';
import { ProjectKnowledgeCueResolver } from './resolvers/ProjectKnowledgeCueResolver.js';
import { TasteCueResolver } from './resolvers/TasteCueResolver.js';
import { CanonicalOperationalPrecedentCueSource } from './sources/OperationalPrecedentCueSource.js';
import { PersonMemoryCueSource } from './sources/PersonMemoryCueSource.js';
import { CanonicalTasteMemoryCueSource } from './sources/TasteMemoryCueSource.js';

export interface MemoryCueRuntime {
  promptService: MemoryCueInvocationPromptService;
  sourceReader: MemoryCueSourceReader;
}

/** Composition root for the three v1 read-only canonical lanes. */
export function createMemoryCueRuntime(input: {
  episodeStore: MemoryCueEpisodeStore;
  handles: MemoryCueDrillHandleService;
  evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>;
  messageStore: Pick<IMessageStore, 'getById'>;
  personRecall?: PersonMemoryRecallService;
  tasteRepository: TasteRepository;
  ownerUserId: string;
}): MemoryCueRuntime {
  const personSource = input.personRecall
    ? new PersonMemoryCueSource({ recall: input.personRecall, messageStore: input.messageStore })
    : null;
  const operationalSource = new CanonicalOperationalPrecedentCueSource(input.evidenceStore);
  const tasteSource = new CanonicalTasteMemoryCueSource(input.tasteRepository, input.ownerUserId);
  const registry = new MemoryCueResolverRegistry([
    new PersonEntityCueResolver(personSource ?? { resolve: async () => null }),
    new OperationalPrecedentCueResolver(operationalSource),
    new TasteCueResolver(tasteSource),
    new ProfileCueResolver(),
    new ProjectKnowledgeCueResolver(),
  ]);
  const plane = new MemoryCuePlaneService(registry, input.episodeStore);
  return {
    promptService: new MemoryCueInvocationPromptService({
      plane,
      createDrillHandle: (coordinate) => input.handles.issue(coordinate),
    }),
    sourceReader: {
      async read(request) {
        if (request.family === 'person_memory') {
          return personSource
            ? personSource.read({
                ownerUserId: request.scope.ownerUserId,
                anchor: request.anchor,
                expectedRevision: request.expectedRevision,
              })
            : { status: 'not_available' as const, invalidationReason: 'source_forgotten' as const };
        }
        if (request.family === 'evidence') {
          return operationalSource.read({
            anchor: request.anchor,
            expectedRevision: request.expectedRevision,
          });
        }
        return tasteSource.read({
          ownerUserId: request.scope.ownerUserId,
          anchor: request.anchor,
          expectedRevision: request.expectedRevision,
        });
      },
    },
  };
}
