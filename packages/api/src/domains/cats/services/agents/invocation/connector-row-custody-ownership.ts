import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';

/**
 * Whether a connector row that was just admitted may stay in the Queue, judged
 * from its source message as it is *after* the row exists. The source is first
 * read before admission, and the carrier that owned it can finish in between —
 * in this process or, after a restart, in one this process cannot see. Reading
 * again once the row is in place leaves no gap for that to slip through.
 *
 * - `unmanaged`: the source never had Queue custody (a plain connector message);
 *   the row is the only carrier there is.
 * - `owned`: the live custody names exactly this row.
 * - `unowned`: the source is canceled, its custody is terminal, or it names
 *   another carrier. Nothing can ever give this row durable ownership — every
 *   start would fail the custody check and roll back — so it must not outlive
 *   admission.
 */
export type ConnectorRowCustodyOwnership = 'unmanaged' | 'owned' | 'unowned';

export function resolveConnectorRowCustodyOwnership(
  source: Pick<StoredMessage, 'deliveryStatus' | 'queueCustody'> | null | undefined,
  row: Pick<QueueEntry, 'id' | 'targetCats'>,
): ConnectorRowCustodyOwnership {
  if (source?.deliveryStatus === 'canceled') return 'unowned';
  const custody = source?.queueCustody;
  if (!custody) return 'unmanaged';
  if (custody.status === 'terminal') return 'unowned';
  const carriers = custody.carrierByTargetCatId;
  const named = carriers
    ? row.targetCats.every((catId) => carriers[catId]?.entryId === row.id)
    : custody.entryId === row.id;
  return named ? 'owned' : 'unowned';
}
