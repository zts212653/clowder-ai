import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import type { MailboxRead } from '../../unified-mailbox-state';

/** The Host's actual two paths: unavailable responsibility requests and optionally partial Needs Me. */
export function collectiveFailure(result: MailboxRead, partialNeedsMe = false): MailboxRead {
  if (result.kind !== 'ok') throw new Error('Expected an owner read');
  const read: UnifiedAttentionReadV1 = structuredClone(result.read);
  read.status = 'partial';
  read.sources.collectiveAccountabilityRequests = {
    status: 'unavailable',
    coverage: 'pending_f290_collective_accountability_requests',
    exhaustiveness: 'unknown',
    startedAt: 1,
    observedAt: 2,
  };
  if (partialNeedsMe) read.sources.needsMe.exhaustiveness = 'partial';
  read.consistency = { state: 'uncertain', reasons: ['collective_accountability_plugin_unavailable'] };
  delete read.totalCount;
  delete read.attentionCount;
  return { kind: 'ok', read };
}
