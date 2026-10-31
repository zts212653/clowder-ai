import type {
  ContentModificationRecord,
  ContentModificationRequest,
  ContentModificationRequestView,
  ContentModificationTakeover,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import type { EntrustedWorkLifecycleService } from '../../../growing/EntrustedWorkLifecycleService.js';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import type { VideoProjectReadPort } from '../../../video-studio/project/types.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import type { VideoProjectMessageImporter } from '../../workspace-review/project-message/import.js';
import type { VideoProjectMessageAuthority } from '../../workspace-review/project-message/types.js';
import type { ResolvedMessageTakeover } from '../message/types.js';
import type { ModificationLabels } from '../request-source.js';

export type ProjectCatPrincipal = Extract<MediaReviewPrincipal, { actor: { kind: 'cat' } }>;
export type ProjectModificationSource = Extract<ContentModificationRequest['source'], { kind: 'video-project' }>;
export interface ProjectMessageTakeoverDeps {
  store: ArtifactReviewStore;
  messages: IMessageStore;
  tasks: ITaskStore;
  turns: Pick<ITurnExecutionStore, 'get'>;
  lifecycle: EntrustedWorkLifecycleService;
  projects: VideoProjectReadPort;
  importer: VideoProjectMessageImporter;
  authority: VideoProjectMessageAuthority;
  authorizeTarget: (
    payload: ContentModificationRequest,
    ownerUserId: string,
  ) => Promise<Pick<ModificationLabels, 'targetName' | 'threadTitle'>>;
  onError: (error: unknown) => void;
}
export interface ProjectMessageTakeoverPort {
  resolve(
    input: ContentModificationTakeover,
    principal: ProjectCatPrincipal,
    existing?: ContentModificationRecord,
  ): Promise<ResolvedMessageTakeover>;
  resume(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<ContentModificationRequestView>;
  read(record: ContentModificationRecord, principal: MediaReviewPrincipal): Promise<ContentModificationRequestView>;
  viewForCat(
    record: ContentModificationRecord,
    principal: ProjectCatPrincipal,
  ): Promise<ContentModificationRequestView>;
}
