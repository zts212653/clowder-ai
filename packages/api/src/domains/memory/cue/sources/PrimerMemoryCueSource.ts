import type { FileProfileRepository } from '../../../cats/services/profile/ProfileRepository.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';

const PREFIX = 'profile:primer:';
export class PrimerMemoryCueSource {
  constructor(private readonly repository: Pick<FileProfileRepository, 'scope' | 'readPrimer'>) {}

  resolvePrimer(ownerUserId: string, consumerCatId: string): MemoryCueSourceProjection | null {
    const scope = this.repository.scope(ownerUserId, consumerCatId);
    const current = this.repository.readPrimer(scope);
    if (!current) return null;
    return {
      // Neutral metadata only. Neither the prompt nor the handle carries these source bytes.
      title: 'Current approved source',
      summary: 'A current source can be read.',
      anchor: `${PREFIX}${encodeURIComponent(scope.relationshipKey)}:${encodeURIComponent(consumerCatId)}`,
      revision: current.revision,
      visibility: 'owner_private',
      drillFamily: 'profile',
    };
  }

  async read(input: { ownerUserId: string; consumerCatId?: string; anchor: string; expectedRevision: string }) {
    if (!input.consumerCatId || !input.anchor.startsWith(PREFIX)) return this.unavailable('scope_revoked');
    let scope;
    try {
      scope = this.repository.scope(input.ownerUserId, input.consumerCatId);
    } catch {
      return this.unavailable('scope_revoked');
    }
    const expectedAnchor = `${PREFIX}${encodeURIComponent(scope.relationshipKey)}:${encodeURIComponent(input.consumerCatId)}`;
    if (input.anchor !== expectedAnchor) return this.unavailable('scope_revoked');
    const current = this.repository.readPrimer(scope);
    if (!current) return this.unavailable('source_forgotten');
    if (current.revision !== input.expectedRevision) return this.unavailable('source_corrected');
    return {
      status: 'ok' as const,
      payload: {
        layer: 'primer',
        uri: 'cat-cafe-profile://relationship/current',
        relationshipKey: scope.relationshipKey,
        consumerCatId: input.consumerCatId,
        sourceRevision: current.revision,
        content: current.content,
      },
    };
  }

  private unavailable(invalidationReason: 'scope_revoked' | 'source_forgotten' | 'source_corrected') {
    return { status: 'not_available' as const, invalidationReason };
  }
}
