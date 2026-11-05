import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import { toolExecutionPolicyDenial } from '../../cats/services/agents/invocation/tool-execution-policy.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { workPublicationContentRef } from '../../video-studio/content-owner/publication.js';
import type {
  MediaReviewPrincipal,
  PublishedMediaAccess,
} from '../../video-studio/content-owner/published-media-access.js';
import type { WorkAuthorizationInput, WorkPrincipal } from './service.js';

export function workMediaPrincipal(principal: WorkPrincipal): MediaReviewPrincipal {
  if (principal.actor.kind === 'human') return { userId: principal.userId, actor: principal.actor };
  return { ...principal, actor: principal.actor };
}

/** Current authenticated production callback + owning thread; foreign authors still need the existing exact Task grant. */
export function createWorkAuthorizer(deps: {
  ownerUserId: string;
  access: PublishedMediaAccess;
  invocation: (id: string) => Promise<InvocationRecord | null>;
}) {
  return async ({ principal, permission, scope }: WorkAuthorizationInput): Promise<void> => {
    if (principal.userId !== deps.ownerUserId) throw new MediaOwnerError('access_denied');
    const mediaPrincipal = workMediaPrincipal(principal);
    await deps.access.authorizeThread(principal.threadId, mediaPrincipal);
    if (scope) {
      if (scope.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
      await deps.access.authorizeScope(scope, mediaPrincipal, true, workPublicationContentRef(scope));
    }
    await requireCurrentProducer(principal, deps.invocation);
    if (permission === 'write' && scope && needsPublicationGrant(principal, scope.createdBy))
      await deps.access.authorizePublicationTask(workPublicationContentRef(scope), mediaPrincipal, false);
  };
}

function needsPublicationGrant(principal: WorkPrincipal, creator: WorkPrincipal['actor']) {
  if (principal.actor.kind === 'human') return false;
  return creator.kind !== 'cat' || creator.actorId !== principal.actor.actorId;
}

async function requireCurrentProducer(
  principal: WorkPrincipal,
  read: (id: string) => Promise<InvocationRecord | null>,
) {
  if (principal.actor.kind === 'human') {
    if (principal.invocationId) throw new MediaOwnerError('access_denied');
    return;
  }
  const invocation = principal.invocationId ? await read(principal.invocationId) : null;
  if (!currentProductionInvocation(invocation, principal)) throw new MediaOwnerError('access_denied');
}

function currentProductionInvocation(invocation: InvocationRecord | null, principal: WorkPrincipal): boolean {
  return (
    invocation !== null &&
    invocation.state === 'active' &&
    invocation.userId === principal.userId &&
    invocation.catId === principal.actor.actorId &&
    invocation.threadId === principal.threadId &&
    invocation.ownerAuthProvenance === 'strict' &&
    toolExecutionPolicyDenial(invocation.toolExecutionPolicy, 'POST /api/callbacks/work') === null
  );
}
