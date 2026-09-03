import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { TasteRepository } from '../../taste/services/TasteRepository.js';
import type { IEventMemoryStore } from '../EventMemoryStore.js';
import type { IEvidenceStore } from '../interfaces.js';
import type { PersonMemoryRecallService } from '../people/PersonMemoryRecallService.js';
import type { MemoryCueDrillHandleService } from './MemoryCueDrillHandleService.js';
import type { MemoryCueEpisodeStore } from './MemoryCueEpisodeStore.js';
import { MemoryCueInvocationPromptService } from './MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from './MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from './MemoryCueResolverRegistry.js';
import type { MemoryCueSourceReader } from './MemoryCueSourceReader.js';
import { EventCueResolver } from './resolvers/EventCueResolver.js';
import { OperationalPrecedentCueResolver } from './resolvers/OperationalPrecedentCueResolver.js';
import { PersonEntityCueResolver } from './resolvers/PersonEntityCueResolver.js';
import { ProfileCueResolver } from './resolvers/ProfileCueResolver.js';
import { ProjectKnowledgeCueResolver } from './resolvers/ProjectKnowledgeCueResolver.js';
import { TasteCueResolver } from './resolvers/TasteCueResolver.js';
import { EventMemoryCueSource } from './sources/EventMemoryCueSource.js';
import { CanonicalOperationalPrecedentCueSource } from './sources/OperationalPrecedentCueSource.js';
import { PersonMemoryCueSource } from './sources/PersonMemoryCueSource.js';
import { ProfileMemoryCueSource } from './sources/ProfileMemoryCueSource.js';
import { CanonicalTasteMemoryCueSource } from './sources/TasteMemoryCueSource.js';

export interface MemoryCueRuntime {
  promptService: MemoryCueInvocationPromptService;
  sourceReader: MemoryCueSourceReader;
  profileOpportunitySource: ProfileMemoryCueSource;
  eventOpportunitySource: EventMemoryCueSource;
}

/** Composition root for the source-backed read-only canonical lanes. */
export function createMemoryCueRuntime(input: {
  episodeStore: MemoryCueEpisodeStore;
  handles: MemoryCueDrillHandleService;
  evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>;
  messageStore: Pick<IMessageStore, 'getById'>;
  eventStore: Pick<IEventMemoryStore, 'listEvents' | 'getEvent'>;
  personRecall?: PersonMemoryRecallService;
  tasteRepository: TasteRepository;
  ownerUserId: string;
  profileRepository: import('../../cats/services/profile/ProfileRepository.js').FileProfileRepository;
}): MemoryCueRuntime {
  const personSource = input.personRecall
    ? new PersonMemoryCueSource({ recall: input.personRecall, messageStore: input.messageStore })
    : null;
  const operationalSource = new CanonicalOperationalPrecedentCueSource(input.evidenceStore);
  const tasteSource = new CanonicalTasteMemoryCueSource(input.tasteRepository, input.ownerUserId);
  const profileSource = new ProfileMemoryCueSource({
    ownerUserId: input.ownerUserId,
    repository: input.profileRepository,
    episodeStore: input.episodeStore,
  });
  const eventSource = new EventMemoryCueSource({
    ownerUserId: input.ownerUserId,
    eventStore: input.eventStore,
    messageStore: input.messageStore,
    episodeStore: input.episodeStore,
  });
  const registry = new MemoryCueResolverRegistry([
    new PersonEntityCueResolver(personSource ?? { resolve: async () => null }),
    new OperationalPrecedentCueResolver(operationalSource),
    new TasteCueResolver(tasteSource),
    new ProfileCueResolver(profileSource),
    new EventCueResolver(eventSource),
    new ProjectKnowledgeCueResolver(),
  ]);
  const plane = new MemoryCuePlaneService(registry, input.episodeStore);
  return {
    promptService: new MemoryCueInvocationPromptService({
      plane,
      createDrillHandle: (coordinate) => input.handles.issue(coordinate),
    }),
    profileOpportunitySource: profileSource,
    eventOpportunitySource: eventSource,
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
        if (request.family === 'profile') {
          return profileSource.read({
            ownerUserId: request.scope.ownerUserId,
            anchor: request.anchor,
            expectedRevision: request.expectedRevision,
          });
        }
        if (request.family === 'event') {
          return eventSource.read({
            ownerUserId: request.scope.ownerUserId,
            threadId: request.scope.threadId,
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
