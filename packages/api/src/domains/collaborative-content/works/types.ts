import type { WorkReference, WorkVersionRecord } from '@cat-cafe/shared';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ContentActorV1, WorkPublicationScopeV1 } from '../../video-studio/content-owner/types.js';

/** Minted by direct-owner or verified callback routes; public DTOs never supply actor authority. */
export interface WorkPrincipal {
  readonly userId: string;
  readonly threadId: string;
  readonly actor: ContentActorV1;
  readonly invocationId?: string;
  readonly contentTaskId?: string;
}

export interface WorkAuthorizationInput {
  readonly principal: WorkPrincipal;
  readonly permission: 'read' | 'write';
  readonly scope?: WorkPublicationScopeV1;
}

export interface WorkReadResult {
  reference: WorkReference;
  currentOwnerRevision: number;
  version: WorkVersionRecord;
  description: Awaited<ReturnType<ProjectContentOwnerService['describe']>>;
  revision: Awaited<ReturnType<ProjectContentOwnerService['describeRevision']>>;
}
