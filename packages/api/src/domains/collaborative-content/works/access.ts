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

/** Current callback identity and resource access; writes additionally require independent production or an exact Task grant. */
export function createWorkAuthorizer(deps: {
  ownerUserId: string;
  access: PublishedMediaAccess;
  invocation: (id: string) => Promise<InvocationRecord | null>;
}) {
  return async (input: WorkAuthorizationInput): Promise<void> => {
    const { principal, permission, scope } = input;
    if (principal.userId !== deps.ownerUserId) throw new MediaOwnerError('access_denied');
    const mediaPrincipal = workMediaPrincipal(principal);
    await deps.access.authorizeThread(principal.threadId, mediaPrincipal);
    if (scope) {
      if (scope.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
      await deps.access.authorizeScope(scope, mediaPrincipal, true, workPublicationContentRef(scope));
    }
    const invocation = await requireCurrentIdentity(principal, deps.invocation);
    if (permission === 'write') await authorizeWorkWrite(input, invocation, deps.access);
  };
}

async function authorizeWorkWrite(
  { principal, scope, operation }: WorkAuthorizationInput,
  invocation: InvocationRecord | null,
  access: PublishedMediaAccess,
) {
  if (principal.actor.kind === 'human') return;
  const mediaPrincipal = workMediaPrincipal(principal);
  // Explicit continuation consumes this exact current grant, including for the original author.
  // A failed grant never falls back to independent production authority.
  if (scope && operation !== 'create' && principal.contentTaskId) {
    await access.authorizePublicationTask(workPublicationContentRef(scope), mediaPrincipal, false);
    return;
  }
  if (invocation?.ownerAuthProvenance !== 'strict') throw new MediaOwnerError('access_denied');
  if (scope && needsPublicationGrant(principal, scope.createdBy))
    await access.authorizePublicationTask(workPublicationContentRef(scope), mediaPrincipal, false);
}

function needsPublicationGrant(principal: WorkPrincipal, creator: WorkPrincipal['actor']) {
  if (principal.actor.kind === 'human') return false;
  return creator.kind !== 'cat' || creator.actorId !== principal.actor.actorId;
}

async function requireCurrentIdentity(
  principal: WorkPrincipal,
  read: (id: string) => Promise<InvocationRecord | null>,
) {
  if (principal.actor.kind === 'human') {
    if (principal.invocationId) throw new MediaOwnerError('access_denied');
    return null;
  }
  const invocation = principal.invocationId ? await read(principal.invocationId) : null;
  if (!isCurrentWorkInvocation(invocation, principal)) throw new MediaOwnerError('access_denied');
  return invocation;
}

function isCurrentWorkInvocation(invocation: InvocationRecord | null, principal: WorkPrincipal): boolean {
  return (
    invocation !== null &&
    invocation.state === 'active' &&
    invocation.userId === principal.userId &&
    invocation.catId === principal.actor.actorId &&
    invocation.threadId === principal.threadId &&
    toolExecutionPolicyDenial(invocation.toolExecutionPolicy, 'POST /api/callbacks/work') === null
  );
}
