import type { GlobalArtifactDTO, GlobalArtifactWork, MessageMediaPublicationSource } from '@cat-cafe/shared';
import type { IndependentWorkCataloguePort } from '../../collaborative-content/works/catalogue.js';
import { MediaOwnerError } from './media-errors.js';
import {
  type MessagePublicationLandingDeps,
  type MessagePublicationLandingMedia,
  resolveMessagePublicationLandingCandidates,
} from './message-publication-landing.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { ProjectContentOwnerService } from './service.js';

const NON_LANDING_CODES = new Set<MediaOwnerError['code']>(['access_denied', 'publication_changed', 'invalid_media']);

interface GlobalArtifactWorkLineageDeps extends MessagePublicationLandingDeps {
  owner: MessagePublicationLandingDeps['owner'] & Pick<ProjectContentOwnerService, 'findSourcePublicationsBatch'>;
}

export interface GlobalArtifactWorkLineageResolverPort {
  resolve(input: {
    ownerUserId: string;
    artifacts: readonly GlobalArtifactDTO[];
  }): Promise<readonly (GlobalArtifactWork | undefined)[]>;
}

/** Late-bound because the global artifact route is registered before F309 runtime composition. */
export interface GlobalArtifactWorkLineageResolverHolder {
  current?: GlobalArtifactWorkLineageResolverPort;
  independent?: IndependentWorkCataloguePort;
}

interface PreparedLookup {
  artifactIndex: number;
  lookupId: string;
  source: MessageMediaPublicationSource;
  identity: Awaited<ReturnType<MessagePublicationLandingDeps['sources']['messageIdentity']>>;
}

/** F309-owned read projection: exact message identity + one complete owner catalogue scan + fresh authorization. */
export class GlobalArtifactWorkLineageResolver implements GlobalArtifactWorkLineageResolverPort {
  constructor(private readonly deps: GlobalArtifactWorkLineageDeps & { media: MessagePublicationLandingMedia }) {}

  async resolve(input: {
    ownerUserId: string;
    artifacts: readonly GlobalArtifactDTO[];
  }): Promise<readonly (GlobalArtifactWork | undefined)[]> {
    const principal: MediaReviewPrincipal = {
      userId: input.ownerUserId,
      actor: { kind: 'human', actorId: input.ownerUserId },
    };
    const threadAuthorizations = new Map<string, Promise<void>>();
    const authorizeThread = (threadId: string) => {
      const existing = threadAuthorizations.get(threadId);
      if (existing) return existing;
      const pending = this.deps.access.authorizeThread(threadId, principal);
      threadAuthorizations.set(threadId, pending);
      return pending;
    };

    const prepared = (
      await Promise.all(
        input.artifacts.map(async (artifact, artifactIndex): Promise<PreparedLookup | undefined> => {
          const source = admittedMessageSource(artifact);
          if (!source) return undefined;
          try {
            await authorizeThread(source.threadId);
            return {
              artifactIndex,
              lookupId: `artifact:${artifactIndex}`,
              source,
              identity: await this.deps.sources.messageIdentity(source, principal),
            };
          } catch (error) {
            if (isNonLanding(error)) return undefined;
            throw error;
          }
        }),
      )
    ).filter((candidate): candidate is PreparedLookup => candidate !== undefined);

    const works = new Array<GlobalArtifactWork | undefined>(input.artifacts.length).fill(undefined);
    if (prepared.length === 0) return works;

    const candidatesByLookup = await this.deps.owner.findSourcePublicationsBatch(
      prepared.map((candidate) => ({
        lookupId: candidate.lookupId,
        ownerUserId: input.ownerUserId,
        sourceRef: candidate.identity.publication.sourceRef,
        artifactRef: candidate.identity.publication.artifactRef,
        revisions: [candidate.identity.publication.revision, candidate.source.messageRevision],
      })),
    );

    const resolved = await Promise.all(
      prepared.map(async (candidate): Promise<GlobalArtifactWork | undefined> => {
        try {
          const landing = await resolveMessagePublicationLandingCandidates(this.deps, this.deps.media, {
            source: candidate.source,
            principal,
            identity: candidate.identity,
            candidates: requireLookupCandidates(candidatesByLookup, candidate.lookupId),
          });
          if (landing?.status !== 'resolved') return undefined;
          const currentOwnerRevision = await this.deps.media.currentRevision(landing.asset.contentRef, principal);
          return {
            contentRef: landing.asset.contentRef,
            ownerRevision: landing.asset.ownerRevision,
            currentOwnerRevision,
          };
        } catch (error) {
          if (isNonLanding(error)) return undefined;
          throw error;
        }
      }),
    );
    for (const [index, candidate] of prepared.entries()) works[candidate.artifactIndex] = resolved[index];
    return works;
  }
}

function admittedMessageSource(artifact: GlobalArtifactDTO): MessageMediaPublicationSource | undefined {
  if (
    !artifact.catId ||
    (artifact.type !== 'image' && artifact.type !== 'video' && artifact.type !== 'file') ||
    artifact.fileLedgerRef !== undefined ||
    !artifact.sourceMessageId ||
    !artifact.url ||
    !artifact.publicationItem
  )
    return undefined;
  return {
    kind: 'message',
    threadId: artifact.threadId,
    messageId: artifact.sourceMessageId,
    messageRevision: String(artifact.createdAt),
    item: artifact.publicationItem,
    expectedUrl: artifact.url,
  };
}

function isNonLanding(error: unknown): boolean {
  return error instanceof MediaOwnerError && NON_LANDING_CODES.has(error.code);
}

function requireLookupCandidates(
  candidatesByLookup: ReadonlyMap<
    string,
    readonly { contentRef: string; ownerRevision: number; sourceRevision: string }[]
  >,
  lookupId: string,
) {
  const candidates = candidatesByLookup.get(lookupId);
  if (!candidates) throw new Error(`Owner batch omitted source publication lookup: ${lookupId}`);
  return candidates;
}
