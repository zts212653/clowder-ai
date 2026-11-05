import type { FileProfileRepository, ProfileScope } from '../../../cats/services/profile/ProfileRepository.js';
import { readProfileOpeningReference, renderProfileOpeningReference } from '../../profile/profile-opening-reference.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';

const PREFIX = 'profile:primer:';
export const OPENING_PRIMER_PREFIX = 'profile:opening-primer:';
export class PrimerMemoryCueSource {
  constructor(private readonly repository: Pick<FileProfileRepository, 'scope' | 'readPrimer'>) {}

  resolvePrimer(
    ownerUserId: string,
    consumerCatId: string,
    options?: { opening: boolean },
  ): MemoryCueSourceProjection | null {
    const scope = this.repository.scope(ownerUserId, consumerCatId);
    const current = this.repository.readPrimer(scope);
    if (!current) return null;
    const reference = options?.opening ? readProfileOpeningReference(current.content) : null;
    return {
      // Neutral metadata only. Neither the prompt nor the handle carries these source bytes.
      title: reference ? '开场递送 · 关系参考' : 'Current approved source',
      summary: reference ? renderProfileOpeningReference(reference) : 'A current source can be read.',
      anchor: `${reference ? OPENING_PRIMER_PREFIX : PREFIX}${encodeURIComponent(scope.relationshipKey)}:${encodeURIComponent(consumerCatId)}`,
      revision: current.revision,
      visibility: 'owner_private',
      drillFamily: 'profile',
    };
  }

  async read(input: { ownerUserId: string; consumerCatId?: string; anchor: string; expectedRevision: string }) {
    const prefix = input.anchor.startsWith(OPENING_PRIMER_PREFIX) ? OPENING_PRIMER_PREFIX : PREFIX;
    if (!input.consumerCatId || !input.anchor.startsWith(prefix)) return this.unavailable('scope_revoked');
    let scope: ProfileScope;
    try {
      scope = this.repository.scope(input.ownerUserId, input.consumerCatId);
    } catch {
      return this.unavailable('scope_revoked');
    }
    const expectedAnchor = `${prefix}${encodeURIComponent(scope.relationshipKey)}:${encodeURIComponent(input.consumerCatId)}`;
    if (input.anchor !== expectedAnchor) return this.unavailable('scope_revoked');
    const current = this.repository.readPrimer(scope);
    if (!current) return this.unavailable('source_forgotten');
    if (current.revision !== input.expectedRevision) return this.unavailable('source_corrected');
    return {
      status: 'ok' as const,
      payload: {
        layer: 'primer',
        profileUri: 'cat-cafe-profile://relationship/current',
        uri: 'cat-cafe-profile://relationship/current',
        relationshipKey: scope.relationshipKey,
        consumerCatId: input.consumerCatId,
        sourceRevision: current.revision,
        content: current.content,
        ...(prefix === OPENING_PRIMER_PREFIX ? { openingReference: readProfileOpeningReference(current.content) } : {}),
      },
    };
  }

  private unavailable(invalidationReason: 'scope_revoked' | 'source_forgotten' | 'source_corrected') {
    return { status: 'not_available' as const, invalidationReason };
  }
}
