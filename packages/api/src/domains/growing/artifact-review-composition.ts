import { join } from 'node:path';
import type { ArtifactReviewRoutesDeps } from '../../routes/artifact-review-routes.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { readPublicationReviewContexts } from '../collaborative-content/artifact-review/publication-contexts.js';
import { ArtifactReviewService } from '../collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../collaborative-content/artifact-review/store.js';
import { ModificationPublicationGrants } from '../collaborative-content/modification/request-authority.js';
import { ModificationTargetService } from '../collaborative-content/modification/target-service.js';
import { ContentTextModificationService } from '../collaborative-content/modification/text/text-service.js';
import type { EvolutionMediaReadPort } from '../collaborative-content/workspace-review/evolution-review-source.js';
import { VideoProjectMessageImporter } from '../collaborative-content/workspace-review/project-message/import.js';
import type { VideoProjectMessageAuthority } from '../collaborative-content/workspace-review/project-message/types.js';
import { WorkspaceContentReviewService } from '../collaborative-content/workspace-review/service.js';
import { VideoProjectReviewService } from '../collaborative-content/workspace-review/video-project-review-service.js';
import type { VideoProjectReviewPort } from '../collaborative-content/workspace-review/video-project-review-source.js';
import type { RoutingDispatchPreflightPort } from '../routing-context/RoutingDispatchPreflightPort.js';
import { GlobalArtifactWorkLineageResolver } from '../video-studio/content-owner/global-artifact-work-lineage.js';
import { PublishedMediaAccess } from '../video-studio/content-owner/published-media-access.js';
import { PublishedMediaService } from '../video-studio/content-owner/published-media-service.js';
import { PublishedMediaSource } from '../video-studio/content-owner/published-media-source.js';
import type { ProjectContentOwnerService } from '../video-studio/content-owner/service.js';
import type { VideoProjectScreeningService } from '../video-studio/project/screening-service.js';
import type { WorkspaceContentSourceService } from '../workspace/workspace-content-source.js';
import { createArtifactReviewRecoveryTaskSpec } from './ArtifactReviewRecoveryTaskSpec.js';
import {
  ArtifactReviewReturnDispatcher,
  type ArtifactReviewReturnDispatcherDeps,
} from './ArtifactReviewReturnDispatcher.js';
import type { PreparedArtifactReader } from './EntrustedWorkOwnerReadService.js';
import { F309ContentReviewProducerAdapter } from './F309ContentReviewProducerAdapter.js';
import { readPreparedMediaReviewContexts } from './PreparedMediaReviewContexts.js';
import { ReviewedMediaArtifactReader } from './ReviewedMediaArtifactReader.js';

export function createArtifactReviewIntegration(deps: {
  dataDir: string;
  uploadDir: string;
  owner: ProjectContentOwnerService;
  projects?: VideoProjectReviewPort;
  screenings?: VideoProjectScreeningService;
  projectMessageAuthority?: VideoProjectMessageAuthority;
  publications: PreparedArtifactReader;
  workspace?: WorkspaceContentSourceService;
  evolution?: EvolutionMediaReadPort;
  routing?: RoutingDispatchPreflightPort;
  tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
  threads: Pick<IThreadStore, 'get' | 'list'>;
  messages: ConstructorParameters<typeof PublishedMediaSource>[0]['messages'];
  readPrivateMessageImage?: ConstructorParameters<typeof PublishedMediaSource>[0]['readPrivateMessageImage'];
  delivery: ArtifactReviewReturnDispatcherDeps['delivery'];
  emit: ArtifactReviewReturnDispatcherDeps['emit'];
  onError: (error: unknown) => void;
}) {
  const store = new ArtifactReviewStore(join(deps.dataDir, 'collaborative-content', 'artifact-reviews.sqlite'));
  const access = new PublishedMediaAccess({
    tasks: deps.tasks,
    threads: deps.threads,
    publicationGrants: new ModificationPublicationGrants(store.requests, deps.messages),
  });
  const sources = new PublishedMediaSource({
    access,
    artifacts: deps.publications,
    messages: deps.messages,
    uploadDir: deps.uploadDir,
    ...(deps.readPrivateMessageImage ? { readPrivateMessageImage: deps.readPrivateMessageImage } : {}),
    ...(deps.workspace ? { workspace: deps.workspace } : {}),
    ...(deps.evolution ? { evolution: deps.evolution } : {}),
  });
  const media = new PublishedMediaService({ owner: deps.owner, access, sources });
  const globalArtifactWorkLineage = new GlobalArtifactWorkLineageResolver({
    owner: deps.owner,
    access,
    sources,
    media,
  });
  const reviews = new ArtifactReviewService({ store, media });
  const ledgers = deps.workspace
    ? new WorkspaceContentReviewService({
        store: store.ledgers,
        source: deps.workspace,
        publications: media,
        publicationContexts: (target, principal) =>
          readPublicationReviewContexts({ store, reviews, media, threads: deps.threads }, target, principal),
        ...(deps.evolution ? { evolution: deps.evolution } : {}),
        ...(deps.projects ? { projects: deps.projects } : {}),
      })
    : undefined;
  const projectMessages =
    deps.projects && deps.screenings && deps.projectMessageAuthority
      ? new VideoProjectMessageImporter({
          store: store.ledgers,
          projects: deps.projects,
          screenings: deps.screenings,
          authority: deps.projectMessageAuthority,
        })
      : undefined;
  const projectReviews =
    projectMessages?.reviews ??
    (deps.projects ? new VideoProjectReviewService({ store: store.ledgers, projects: deps.projects }) : undefined);
  const invalidate = (ownerUserId: string) =>
    deps.emit(ownerUserId, 'entrusted_work_projection_invalidated', { ownerUserId });
  const notifyChanged = (ownerUserId: string, reviewId: string) => {
    invalidate(ownerUserId);
    deps.emit(ownerUserId, 'artifact_review_changed', { reviewId });
  };
  const producer = new F309ContentReviewProducerAdapter({ store, reviews, onChanged: notifyChanged });
  const artifactReader = new ReviewedMediaArtifactReader({ store, reviews, publications: deps.publications });
  const targets = new ModificationTargetService({
    threads: deps.threads,
    ...(deps.routing ? { routing: deps.routing } : {}),
  });
  const text = deps.workspace
    ? new ContentTextModificationService({
        store,
        access,
        source: deps.workspace,
        messages: deps.messages,
        executionDirectory: join(deps.dataDir, 'collaborative-content', 'text-execution'),
      })
    : undefined;
  const dispatcher = new ArtifactReviewReturnDispatcher({
    ...deps,
    store,
    reviews,
    invalidate,
    ...(text ? { text } : {}),
    authorizeDelivery: (intent) => targets.authorizeDelivery(intent),
  });
  const changed: ArtifactReviewRoutesDeps['changed'] = async (ownerUserId, reviewId) => {
    notifyChanged(ownerUserId, reviewId);
    try {
      await dispatcher.drain();
    } catch (error) {
      deps.onError(error);
    }
  };
  return {
    uploadDirectory: deps.uploadDir,
    media,
    globalArtifactWorkLineage,
    text,
    targets,
    ledgers,
    publicationReads: { media, ledgers: store.ledgers, messages: deps.messages },
    projectReviews,
    projectMessages,
    reviews,
    store,
    producer,
    artifactReader,
    dispatcher,
    changed,
    contexts: ((input, principal) =>
      readPreparedMediaReviewContexts(
        { tasks: deps.tasks, access, artifacts: artifactReader },
        input,
        principal,
      )) satisfies ArtifactReviewRoutesDeps['contexts'],
    recoverySpec: createArtifactReviewRecoveryTaskSpec({
      store,
      reviews,
      producer,
      dispatcher,
      onChanged: notifyChanged,
      onError: deps.onError,
    }),
  };
}
