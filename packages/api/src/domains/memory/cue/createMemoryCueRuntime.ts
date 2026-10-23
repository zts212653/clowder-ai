import type { AutoDreamStore } from '../../auto-dream/AutoDreamStore.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { TasteRepository } from '../../taste/services/TasteRepository.js';
import type { EntityRegistryStore } from '../EntityRegistry.js';
import type { IEventMemoryStore } from '../EventMemoryStore.js';
import type { IEvidenceStore } from '../interfaces.js';
import type { PersonMemoryRecallService } from '../people/PersonMemoryRecallService.js';
import type { TasteMemoryLifecycleStore } from '../taste/TasteMemoryLifecycleStore.js';
import { ContextSourceAdmission } from './ContextSourceAdmission.js';
import type { ContextSourceOpportunityStore } from './ContextSourceOpportunityStore.js';
import type { MemoryCueDrillHandleService } from './MemoryCueDrillHandleService.js';
import type { MemoryCueEpisodeStore } from './MemoryCueEpisodeStore.js';
import { MemoryCueInvocationPromptService } from './MemoryCueInvocationPromptService.js';
import { MemoryCuePlaneService } from './MemoryCuePlaneService.js';
import { MemoryCueResolverRegistry } from './MemoryCueResolverRegistry.js';
import type { MemoryCueSourceReader } from './MemoryCueSourceReader.js';
import { CatOwnedSeedCueResolver } from './resolvers/CatOwnedSeedCueResolver.js';
import { DecisionCueResolver } from './resolvers/DecisionCueResolver.js';
import { EventCueResolver } from './resolvers/EventCueResolver.js';
import { OperationalPrecedentCueResolver } from './resolvers/OperationalPrecedentCueResolver.js';
import { PersonEntityCueResolver } from './resolvers/PersonEntityCueResolver.js';
import { ProfileCueResolver } from './resolvers/ProfileCueResolver.js';
import { ProjectKnowledgeCueResolver } from './resolvers/ProjectKnowledgeCueResolver.js';
import { TasteCueResolver } from './resolvers/TasteCueResolver.js';
import { CatOwnedSeedMemoryCueSource } from './sources/CatOwnedSeedMemoryCueSource.js';
import { ContextProjectCueSource } from './sources/ContextProjectCueSource.js';
import { DecisionMemoryCueSource } from './sources/DecisionMemoryCueSource.js';
import { EventMemoryCueSource } from './sources/EventMemoryCueSource.js';
import { CanonicalOperationalPrecedentCueSource } from './sources/OperationalPrecedentCueSource.js';
import { PersonMemoryCueSource } from './sources/PersonMemoryCueSource.js';
import { PrimerMemoryCueSource } from './sources/PrimerMemoryCueSource.js';
import { ProfileMemoryCueSource } from './sources/ProfileMemoryCueSource.js';
import { ProjectKnowledgeMemoryCueSource } from './sources/ProjectKnowledgeMemoryCueSource.js';
import { CanonicalTasteMemoryCueSource } from './sources/TasteMemoryCueSource.js';
import type { ThreadOverviewMemoryCueSource } from './sources/ThreadOverviewMemoryCueSource.js';

export interface MemoryCueRuntime {
  promptService: MemoryCueInvocationPromptService;
  contextSourceAdmission?: ContextSourceAdmission;
  sourceReader: MemoryCueSourceReader;
  profileOpportunitySource: ProfileMemoryCueSource;
  eventOpportunitySource: EventMemoryCueSource;
  threadOverviewOpportunitySource?: ThreadOverviewMemoryCueSource;
}

/** Composition root for the source-backed read-only canonical lanes. */
export function createMemoryCueRuntime(input: {
  threadOverviewSource?: ThreadOverviewMemoryCueSource;
  contextProjectDiscovery?: ConstructorParameters<typeof ContextProjectCueSource>[0];
  contextSourceOpportunityStore?: ContextSourceOpportunityStore;
  contextSourceAuthorization?: Omit<ConstructorParameters<typeof ContextSourceAdmission>[0], 'store' | 'messages'>;
  episodeStore: MemoryCueEpisodeStore;
  handles: MemoryCueDrillHandleService;
  evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>;
  messageStore: Pick<IMessageStore, 'getById'>;
  eventStore: Pick<IEventMemoryStore, 'listEvents' | 'getEvent'>;
  entityRegistry: Pick<EntityRegistryStore, 'isCurrentVisibleRevision'>;
  personRecall?: PersonMemoryRecallService;
  tasteRepository: TasteRepository;
  tasteLifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
  ownerUserId: string;
  profileRepository: import('../../cats/services/profile/ProfileRepository.js').FileProfileRepository;
  projectDocsRoot: string;
  autoDreamStore: Pick<AutoDreamStore, 'getOwnedSeed'>;
}): MemoryCueRuntime {
  const personSource = input.personRecall
    ? new PersonMemoryCueSource({ recall: input.personRecall, messageStore: input.messageStore })
    : null;
  const operationalSource = new CanonicalOperationalPrecedentCueSource(input.evidenceStore);
  const tasteSource = new CanonicalTasteMemoryCueSource(input.tasteRepository, input.ownerUserId, input.tasteLifecycle);
  const primerSource = new PrimerMemoryCueSource(input.profileRepository);
  const contextProjectSource = input.contextProjectDiscovery
    ? new ContextProjectCueSource(input.contextProjectDiscovery)
    : undefined;
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
  const decisionSource = new DecisionMemoryCueSource({
    projectDocsRoot: input.projectDocsRoot,
    evidenceStore: input.evidenceStore,
    episodeStore: input.episodeStore,
  });
  const projectKnowledgeSource = new ProjectKnowledgeMemoryCueSource({
    projectDocsRoot: input.projectDocsRoot,
    evidenceStore: input.evidenceStore,
    episodeStore: input.episodeStore,
  });
  const catOwnedSeedSource = new CatOwnedSeedMemoryCueSource(input.autoDreamStore);
  const registry = new MemoryCueResolverRegistry([
    new PersonEntityCueResolver(personSource ?? { resolve: async () => null }, input.entityRegistry),
    new OperationalPrecedentCueResolver(operationalSource),
    new TasteCueResolver(tasteSource),
    new ProfileCueResolver(profileSource, primerSource),
    new EventCueResolver(eventSource),
    new DecisionCueResolver(decisionSource),
    new ProjectKnowledgeCueResolver(projectKnowledgeSource, contextProjectSource, input.messageStore),
    new CatOwnedSeedCueResolver(catOwnedSeedSource),
    input.threadOverviewSource ?? { family: 'thread_overview', resolverVersion: 1, resolve: async () => [] },
  ]);
  const plane = new MemoryCuePlaneService(registry, input.episodeStore);
  const contextSourceAdmission =
    input.contextSourceOpportunityStore && input.contextSourceAuthorization
      ? new ContextSourceAdmission({
          ...input.contextSourceAuthorization,
          messages: input.messageStore,
          store: input.contextSourceOpportunityStore,
        })
      : undefined;
  const runtime: MemoryCueRuntime = {
    ...(contextSourceAdmission ? { contextSourceAdmission } : {}),
    promptService: new MemoryCueInvocationPromptService({
      plane,
      sourceReader: { read: (request) => runtime.sourceReader.read(request) },
      validateContextSource: (id, scope, cat, now) =>
        contextSourceAdmission?.validate(id, scope, cat, now) ?? Promise.resolve(false),
      recordOmission: (id, reason) => input.contextSourceOpportunityStore?.recordOmission(id, reason),
      onProviderCommitted: (receipts, confirmation) => {
        for (const receipt of receipts)
          input.contextSourceOpportunityStore?.markProviderCommitted(
            receipt.event.opportunityId,
            confirmation.generationId,
          );
      },
      createDrillHandle: (coordinate) => input.handles.issue(coordinate),
    }),
    profileOpportunitySource: profileSource,
    eventOpportunitySource: eventSource,
    ...(input.threadOverviewSource ? { threadOverviewOpportunitySource: input.threadOverviewSource } : {}),
    sourceReader: {
      async read(request) {
        if (request.anchor.startsWith('project-collection:') || request.anchor.startsWith('profile:primer:')) {
          if (
            !request.opportunityId ||
            !request.consumerCatId ||
            !contextSourceAdmission ||
            !(await contextSourceAdmission.validate(
              request.opportunityId,
              request.scope,
              request.consumerCatId,
              Date.now(),
            ))
          ) {
            return { status: 'not_available', invalidationReason: 'scope_revoked' };
          }
        }
        if (request.family === 'thread_overview') {
          return input.threadOverviewSource
            ? input.threadOverviewSource.read({
                ownerUserId: request.scope.ownerUserId,
                consumerCatId: request.consumerCatId,
                anchor: request.anchor,
                expectedRevision: request.expectedRevision,
              })
            : { status: 'not_available' as const, invalidationReason: 'source_forgotten' as const };
        }
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
          if (request.anchor.startsWith('project-collection:'))
            return contextProjectSource
              ? contextProjectSource.read({
                  scope: request.scope,
                  anchor: request.anchor,
                  expectedRevision: request.expectedRevision,
                  window: request.window,
                })
              : { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
          if (/^ADR-\d{3}$/.test(request.anchor)) {
            return decisionSource.read({
              anchor: request.anchor,
              expectedRevision: request.expectedRevision,
              window: request.window,
            });
          }
          if (/^F\d{3,}$/.test(request.anchor)) {
            return projectKnowledgeSource.read({
              anchor: request.anchor,
              expectedRevision: request.expectedRevision,
              window: request.window,
            });
          }
          return operationalSource.read({
            anchor: request.anchor,
            expectedRevision: request.expectedRevision,
          });
        }
        if (request.family === 'profile') {
          if (request.anchor.startsWith('profile:primer:'))
            return primerSource.read({
              ownerUserId: request.scope.ownerUserId,
              consumerCatId: request.consumerCatId,
              anchor: request.anchor,
              expectedRevision: request.expectedRevision,
            });
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
        if (request.family === 'owned_seed') {
          if (!request.consumerCatId) {
            return { status: 'not_available' as const, invalidationReason: 'scope_revoked' as const };
          }
          return catOwnedSeedSource.read({
            ownerUserId: request.scope.ownerUserId,
            consumerCatId: request.consumerCatId,
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
  return runtime;
}
