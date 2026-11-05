import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactConstraint,
  type CollectiveArtifactRelayOperation,
  collectiveArtifactReviewActionCommandSchema,
} from '@cat-cafe/shared';
import {
  type CollectiveContentScopeV1,
  collectiveContentScopeRef,
} from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { LoadedProjectContentV1 } from '../../video-studio/content-owner/types.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { CollectiveArtifactOwnerPort } from './owner-port.js';

export interface AdmittedCollectiveMarkdown {
  constraint: CollectiveArtifactConstraint;
  scope: CollectiveContentScopeV1;
  content: LoadedProjectContentV1;
  operationId: string;
  authorize(): Promise<void>;
}

export async function admitCollectiveMarkdown(
  owner: ProjectContentOwnerService,
  operation: CollectiveArtifactRelayOperation,
  authority: Parameters<CollectiveArtifactOwnerPort['execute']>[1],
): Promise<AdmittedCollectiveMarkdown> {
  const constraint = operation.constraint;
  if (constraint.mediaReviewReply) throw new WorkspaceContentReviewError('access_denied');
  if (constraint.reviewReply) {
    const parsed = collectiveArtifactReviewActionCommandSchema.safeParse(operation.payload);
    if (
      constraint.action !== 'annotate' ||
      constraint.agent ||
      !parsed.success ||
      parsed.data.action.kind !== 'reply' ||
      parsed.data.action.annotationId !== constraint.reviewReply.annotationId ||
      parsed.data.action.messageEventId !== constraint.reviewReply.messageEventId
    )
      throw new WorkspaceContentReviewError('access_denied');
  }
  const authorize = async () => {
    const fresh = await authority.reauthorize();
    if (!isDeepStrictEqual(fresh, constraint) || operation.expiresAt <= Date.now() || fresh.expiresAt <= Date.now())
      throw new WorkspaceContentReviewError('access_denied');
    const described = await owner.describe(constraint.contentRef, constraint.ownerRevision);
    assertScope(described, constraint);
  };
  await authorize();
  const content = await owner.load(constraint.contentRef, constraint.ownerRevision);
  const scope = assertScope(content, constraint);
  await authorize();
  return {
    constraint,
    scope,
    content,
    authorize,
    operationId: `collective-operation:${createHash('sha256')
      .update(
        JSON.stringify([
          constraint.serviceInstanceId,
          constraint.collectiveId,
          constraint.artifactId,
          constraint.humanId,
          constraint.action,
          operation.requestId,
        ]),
      )
      .digest('hex')}`,
  };
}

function assertScope(content: Omit<LoadedProjectContentV1, 'bytes'>, constraint: CollectiveArtifactConstraint) {
  const scope = content.collectiveScope;
  if (
    !scope ||
    content.mediaType !== 'text/markdown' ||
    content.byteLength > 65536 ||
    content.ownerRevision !== constraint.ownerRevision ||
    content.blobDigest !== constraint.blobDigest ||
    scope.contentRef !== constraint.contentRef ||
    scope.artifactId !== constraint.artifactId ||
    scope.serviceInstanceId !== constraint.serviceInstanceId ||
    scope.collectiveId !== constraint.collectiveId ||
    scope.sourceEventId !== constraint.sourceEventId
  )
    throw new WorkspaceContentReviewError('access_denied');
  collectiveContentScopeRef(scope);
  return scope;
}

export function collectiveOwnerDecisionRef(admitted: AdmittedCollectiveMarkdown) {
  return `owner-allow:${createHash('sha256')
    .update(
      JSON.stringify([
        collectiveContentScopeRef(admitted.scope),
        admitted.constraint.decisionRef,
        admitted.operationId,
      ]),
    )
    .digest('hex')}`;
}
