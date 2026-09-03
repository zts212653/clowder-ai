import { createHash } from 'node:crypto';
import { CURRENT_RELATIONSHIP_PROFILE_URI } from '@cat-cafe/shared/profile-contract';
import type { FileProfileRepository } from '../../../cats/services/profile/ProfileRepository.js';
import type { MemoryCueEpisodeStore } from '../MemoryCueEpisodeStore.js';
import type { MemoryCueOpportunitySeed } from '../MemoryCueInvocationPromptService.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { ProfileCueSource } from '../resolvers/ProfileCueResolver.js';

export { CURRENT_RELATIONSHIP_PROFILE_URI };

const PROFILE_ANCHOR = `profile:${CURRENT_RELATIONSHIP_PROFILE_URI}`;

function revisionOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export type ProfileMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' | 'scope_revoked' };

export class ProfileMemoryCueSource implements ProfileCueSource {
  constructor(
    private readonly deps: {
      ownerUserId: string;
      repository: Pick<FileProfileRepository, 'readCapsule'>;
      episodeStore: Pick<MemoryCueEpisodeStore, 'hasTerminalConsumptionForSource'>;
    },
  ) {}

  async prepareOpportunity(input: {
    ownerUserId: string;
    occurredAt: number;
  }): Promise<Extract<MemoryCueOpportunitySeed, { kind: 'profile_revision_available' }> | null> {
    const snapshot = this.snapshot(input.ownerUserId);
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

  async resolve(input: {
    ownerUserId: string;
    profileUri: typeof CURRENT_RELATIONSHIP_PROFILE_URI;
    sourceRevision: string;
  }): Promise<MemoryCueSourceProjection | null> {
    if (input.profileUri !== CURRENT_RELATIONSHIP_PROFILE_URI) return null;
    const snapshot = this.snapshot(input.ownerUserId);
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
    if (input.anchor !== PROFILE_ANCHOR) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const snapshot = this.snapshot(input.ownerUserId);
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

  private snapshot(ownerUserId: string): { content: string; revision: string } | null {
    if (ownerUserId !== this.deps.ownerUserId) return null;
    const capsule = this.deps.repository.readCapsule(ownerUserId);
    if (!capsule) return null;
    return { content: capsule.content, revision: revisionOf(capsule.content) };
  }
}
