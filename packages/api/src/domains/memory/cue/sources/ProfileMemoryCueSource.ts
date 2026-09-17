import { CURRENT_CORPUS_PROFILE_URI, CURRENT_RELATIONSHIP_PROFILE_URI } from '@cat-cafe/shared/profile-contract';
import { profileRevisionOf } from '@cat-cafe/shared/profile-revision';
import type { FileProfileRepository } from '../../../cats/services/profile/ProfileRepository.js';
import type { MemoryCueEpisodeStore } from '../MemoryCueEpisodeStore.js';
import type { MemoryCueOpportunitySeed } from '../MemoryCueInvocationPromptService.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { ProfileCueSource } from '../resolvers/ProfileCueResolver.js';

export { CURRENT_RELATIONSHIP_PROFILE_URI };

const PROFILE_ANCHOR = `profile:${CURRENT_RELATIONSHIP_PROFILE_URI}`;
const CORPUS_ANCHOR = `profile:${CURRENT_CORPUS_PROFILE_URI}`;

export type ProfileMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' | 'scope_revoked' };

export class ProfileMemoryCueSource implements ProfileCueSource {
  constructor(
    private readonly deps: {
      ownerUserId: string;
      repository: Pick<FileProfileRepository, 'readCapsule' | 'readCorpus'>;
      episodeStore: Pick<MemoryCueEpisodeStore, 'hasTerminalConsumptionForSource'>;
    },
  ) {}

  async prepareOpportunity(input: {
    ownerUserId: string;
    occurredAt: number;
  }): Promise<Extract<MemoryCueOpportunitySeed, { kind: 'profile_revision_available' }> | null> {
    // Phase E: maxCues=1 priority — capsule/relationship first, then corpus.
    // Only one cue per invocation to avoid budget bloat (INV-4 L0 budget cap).
    const capsuleOpp = this.prepareCapsuleOpportunity(input);
    if (capsuleOpp) return capsuleOpp;
    return this.prepareCorpusOpportunity(input);
  }

  private prepareCapsuleOpportunity(input: {
    ownerUserId: string;
    occurredAt: number;
  }): Extract<MemoryCueOpportunitySeed, { kind: 'profile_revision_available' }> | null {
    const snapshot = this.capsuleSnapshot(input.ownerUserId);
    if (!snapshot) return null;
    if (
      this.deps.episodeStore.hasTerminalConsumptionForSource({
        ownerUserId: input.ownerUserId,
        resolverFamily: 'profile',
        sourceAnchor: PROFILE_ANCHOR,
        sourceRevision: snapshot.revision,
      })
    ) {
      return null;
    }
    return {
      kind: 'profile_revision_available',
      producer: 'profile_repository',
      occurredAt: input.occurredAt,
      payload: {
        profileUri: CURRENT_RELATIONSHIP_PROFILE_URI,
        sourceRevision: snapshot.revision,
      },
    };
  }

  prepareCorpusOpportunity(input: {
    ownerUserId: string;
    occurredAt: number;
  }): Extract<MemoryCueOpportunitySeed, { kind: 'profile_revision_available' }> | null {
    // Fail closed: only produce cues for the bound owner (same gate as capsuleSnapshot).
    if (input.ownerUserId !== this.deps.ownerUserId) return null;
    const corpus = this.deps.repository.readCorpus(input.ownerUserId);
    if (!corpus) return null;
    const revision = profileRevisionOf(corpus.content);
    if (
      this.deps.episodeStore.hasTerminalConsumptionForSource({
        ownerUserId: input.ownerUserId,
        resolverFamily: 'profile',
        sourceAnchor: CORPUS_ANCHOR,
        sourceRevision: revision,
      })
    ) {
      return null;
    }
    return {
      kind: 'profile_revision_available',
      producer: 'profile_repository',
      occurredAt: input.occurredAt,
      payload: {
        profileUri: CURRENT_CORPUS_PROFILE_URI,
        sourceRevision: revision,
      },
    };
  }

  async resolve(input: {
    ownerUserId: string;
    profileUri: typeof CURRENT_RELATIONSHIP_PROFILE_URI | typeof CURRENT_CORPUS_PROFILE_URI;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null> {
    if (input.profileUri === CURRENT_CORPUS_PROFILE_URI) {
      // Fail closed: only resolve for the bound owner.
      if (input.ownerUserId !== this.deps.ownerUserId) return null;
      const corpus = this.deps.repository.readCorpus(input.ownerUserId);
      if (!corpus) return null;
      const revision = profileRevisionOf(corpus.content);
      if (revision !== input.sourceRevision) return null;
      return {
        title: 'A current owner-wide shared corpus revision is available',
        summary: 'Drill the shared corpus facts and use them to personalize this owner-facing response.',
        anchor: CORPUS_ANCHOR,
        revision,
        visibility: 'owner_private',
        drillFamily: 'profile',
      };
    }
    if (input.profileUri !== CURRENT_RELATIONSHIP_PROFILE_URI) return null;
    const snapshot = this.capsuleSnapshot(input.ownerUserId);
    if (!snapshot || snapshot.revision !== input.sourceRevision) return null;
    return {
      title: 'A current owner Profile revision is available',
      summary: 'Drill the bounded approved capsule and use it only to personalize this owner-facing response.',
      anchor: PROFILE_ANCHOR,
      revision: snapshot.revision,
      visibility: 'owner_private',
      drillFamily: 'profile',
    };
  }

  async read(input: {
    ownerUserId: string;
    anchor: string;
    expectedRevision: string;
  }): Promise<ProfileMemoryCueReadResult> {
    if (input.ownerUserId !== this.deps.ownerUserId) {
      return { status: 'not_available', invalidationReason: 'scope_revoked' };
    }
    if (input.anchor === CORPUS_ANCHOR) {
      return this.readCorpusSnapshot(input.ownerUserId, input.expectedRevision);
    }
    if (input.anchor !== PROFILE_ANCHOR) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const snapshot = this.capsuleSnapshot(input.ownerUserId);
    if (!snapshot) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (snapshot.revision !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return {
      status: 'ok',
      payload: {
        profileUri: CURRENT_RELATIONSHIP_PROFILE_URI,
        content: snapshot.content,
        sourceRevision: snapshot.revision,
      },
    };
  }

  private readCorpusSnapshot(ownerUserId: string, expectedRevision: string): ProfileMemoryCueReadResult {
    const corpus = this.deps.repository.readCorpus(ownerUserId);
    if (!corpus) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    const revision = profileRevisionOf(corpus.content);
    if (revision !== expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return {
      status: 'ok',
      payload: {
        profileUri: CURRENT_CORPUS_PROFILE_URI,
        content: corpus.content,
        sourceRevision: revision,
      },
    };
  }

  private capsuleSnapshot(ownerUserId: string): { content: string; revision: string } | null {
    if (ownerUserId !== this.deps.ownerUserId) return null;
    const capsule = this.deps.repository.readCapsule(ownerUserId);
    if (!capsule) return null;
    return { content: capsule.content, revision: profileRevisionOf(capsule.content) };
  }
}
