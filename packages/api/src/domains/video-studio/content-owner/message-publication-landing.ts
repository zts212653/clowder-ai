import {
  catRegistry,
  type MessageMediaPublicationSource,
  type MessagePublicationChoice,
  type MessagePublicationLanding,
} from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal, PublishedMediaAccess } from './published-media-access.js';
import type { PublishedMediaService } from './published-media-service.js';
import type { PublishedMediaSource } from './published-media-source.js';
import type { ProjectContentOwnerService } from './service.js';
import { isTaskPublicationScope } from './types.js';

export type MessagePublicationIdentity = Awaited<ReturnType<PublishedMediaSource['messageIdentity']>>;
export type MessagePublicationCandidate = Awaited<
  ReturnType<ProjectContentOwnerService['findSourcePublications']>
>[number];

export interface MessagePublicationLandingDeps {
  owner: Pick<ProjectContentOwnerService, 'describe'>;
  access: Pick<PublishedMediaAccess, 'authorize' | 'authorizeThread' | 'threadTitle'>;
  sources: Pick<PublishedMediaSource, 'messageIdentity'>;
}

export type MessagePublicationLandingMedia = Pick<PublishedMediaService, 'currentRevision' | 'read'>;

export class MessagePublicationChoiceRequired extends Error {
  constructor(readonly landing: Extract<MessagePublicationLanding, { status: 'choice-required' }>) {
    super('publication_choice_required');
  }
}

/** Source coordinates locate retained objects; they never grant access or merge their ledgers. */
export async function findMessagePublicationLanding(
  deps: { owner: ProjectContentOwnerService; access: PublishedMediaAccess; sources: PublishedMediaSource },
  media: PublishedMediaService,
  input: {
    source: MessageMediaPublicationSource;
    principal: MediaReviewPrincipal;
    selection?: { contentRef: string; ownerRevision: number };
  },
): Promise<MessagePublicationLanding | null> {
  const { source, principal } = input;
  await deps.access.authorizeThread(source.threadId, principal);
  const identity = await deps.sources.messageIdentity(source, principal);
  const candidates = await deps.owner.findSourcePublications({
    ownerUserId: principal.userId,
    sourceRef: identity.publication.sourceRef,
    artifactRef: identity.publication.artifactRef,
    revisions: [identity.publication.revision, source.messageRevision],
  });
  return resolveMessagePublicationLandingCandidates(deps, media, { ...input, identity, candidates });
}

/** Resolve pre-batched owner candidates with the same authorization and ambiguity rules as the interactive landing. */
export async function resolveMessagePublicationLandingCandidates(
  deps: MessagePublicationLandingDeps,
  media: MessagePublicationLandingMedia,
  input: {
    source: MessageMediaPublicationSource;
    principal: MediaReviewPrincipal;
    identity: MessagePublicationIdentity;
    candidates: readonly MessagePublicationCandidate[];
    selection?: { contentRef: string; ownerRevision: number };
  },
): Promise<MessagePublicationLanding | null> {
  const { source, principal, identity, candidates } = input;
  const choices: MessagePublicationChoice[] = [];
  for (const candidate of candidates) {
    const choice = await readAuthorizedChoice(deps, media, { source, principal, identity, candidate });
    if (choice) choices.push(choice);
  }
  // Known but revoked lineage must not be laundered through a fresh message-scoped import.
  const fresh = await deps.sources.messageIdentity(source, principal);
  if (fresh.matchingItemCount !== identity.matchingItemCount) throw new MediaOwnerError('publication_changed');
  if (candidates.length && !choices.length) throw new MediaOwnerError('access_denied');
  if (input.selection) {
    const selected = choices.find(
      (choice) =>
        choice.asset.contentRef === input.selection?.contentRef &&
        choice.asset.ownerRevision === input.selection.ownerRevision,
    );
    if (!selected) throw new MediaOwnerError('publication_changed');
    await media.read(selected.asset.contentRef, selected.asset.ownerRevision, principal);
    return { status: 'resolved', ownerUserId: principal.userId, asset: selected.asset };
  }
  if (!choices.length) return null;
  const unavailableContexts = candidates.length > choices.length;
  const onlyChoice = choices.length === 1 ? choices[0] : undefined;
  if (onlyChoice?.match === 'exact' && !unavailableContexts)
    return { status: 'resolved', ownerUserId: principal.userId, asset: onlyChoice.asset };
  return {
    status: 'choice-required',
    ownerUserId: principal.userId,
    choices,
    ...(unavailableContexts ? { unavailableContexts: true } : {}),
  };
}

async function readAuthorizedChoice(
  deps: MessagePublicationLandingDeps,
  media: MessagePublicationLandingMedia,
  input: {
    source: MessageMediaPublicationSource;
    principal: MediaReviewPrincipal;
    identity: MessagePublicationIdentity;
    candidate: MessagePublicationCandidate;
  },
): Promise<MessagePublicationChoice | undefined> {
  const { source, principal, identity, candidate } = input;
  try {
    const asset = await media.read(candidate.contentRef, candidate.ownerRevision, principal);
    const description = await deps.owner.describe(candidate.contentRef, candidate.ownerRevision);
    const scope = description.publicationScope;
    if (!scope) throw new MediaOwnerError('access_denied');
    const task = isTaskPublicationScope(scope)
      ? await deps.access.authorize(scope.taskId, principal, { allowClosed: true })
      : null;
    return {
      asset,
      title: identity.fileName,
      threadTitle: await deps.access.threadTitle(scope.threadId, principal),
      ...(task
        ? {
            taskTitle: task.title,
            targetName: task.ownerCatId
              ? (catRegistry.tryGet(task.ownerCatId)?.config.displayName ?? task.ownerCatId)
              : '原负责人不可用',
          }
        : {}),
      match:
        candidate.sourceRevision === source.messageRevision && identity.matchingItemCount !== 1
          ? 'legacy-ambiguous'
          : 'exact',
    };
  } catch (error) {
    if (error instanceof MediaOwnerError && error.code === 'access_denied') return undefined;
    throw error;
  }
}
