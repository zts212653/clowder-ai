import { createHash } from 'node:crypto';
import type { EvidenceItem, IEvidenceStore } from '../../interfaces.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import type { OperationalPrecedentCueSource } from '../resolvers/OperationalPrecedentCueResolver.js';

export const BILLING_ONLY_EVIDENCE_ANCHOR = 'LL-098';

function evidenceRevision(item: EvidenceItem): string {
  if (item.sourceHash) return item.sourceHash.startsWith('sha256:') ? item.sourceHash : `sha256:${item.sourceHash}`;
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        anchor: item.anchor,
        status: item.status,
        title: item.title,
        summary: item.summary,
        sourcePath: item.sourcePath,
        updatedAt: item.updatedAt,
      }),
    )
    .digest('hex')}`;
}

function isActiveBillingPrecedent(item: EvidenceItem | null): item is EvidenceItem {
  return Boolean(
    item &&
      item.anchor === BILLING_ONLY_EVIDENCE_ANCHOR &&
      item.kind === 'lesson' &&
      !['invalidated', 'superseded', 'retired', 'archived'].includes(item.status),
  );
}

export type OperationalPrecedentCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' | 'superseded' };

/** Fixed-coordinate projection over LL-098; never performs a free-text/global search. */
export class CanonicalOperationalPrecedentCueSource implements OperationalPrecedentCueSource {
  constructor(private readonly evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>) {}

  async resolve(input: {
    ownerUserId: string;
    repoFullName: string;
    prNumber: number;
    headSha: string;
    externalCondition: 'billing_spending_limit_zero_step';
    candidateAction: 'merge';
    sourceMessageId: string;
  }): Promise<MemoryCueSourceProjection | null> {
    void input;
    const item = await this.evidenceStore.getByAnchor(BILLING_ONLY_EVIDENCE_ANCHOR);
    if (!isActiveBillingPrecedent(item)) return null;
    return {
      title: item.title,
      summary: item.summary ?? 'A zero-step billing failure is external infrastructure evidence, not code truth.',
      anchor: item.anchor,
      revision: evidenceRevision(item),
      visibility: 'owner_public',
      drillFamily: 'evidence',
    };
  }

  async read(input: { anchor: string; expectedRevision: string }): Promise<OperationalPrecedentCueReadResult> {
    if (input.anchor !== BILLING_ONLY_EVIDENCE_ANCHOR) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const item = await this.evidenceStore.getByAnchor(input.anchor);
    if (!item) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (item.status === 'superseded' || item.supersededBy) {
      return { status: 'not_available', invalidationReason: 'superseded' };
    }
    if (!isActiveBillingPrecedent(item)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    if (evidenceRevision(item) !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return { status: 'ok', payload: item };
  }
}
