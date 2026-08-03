import type { FreshnessSupplementAggregate, FreshnessSupplementProjection } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { projectFreshnessSupplement, SUPPLEMENT_DECLINE_MARKER } from './freshness-output-contract.js';

/**
 * Detect the short-lived F177/F254 protocol leak without hiding ordinary cat
 * speech that happens to mention the marker. Durable supplement provenance is
 * required before the control text may be removed from the browser timeline.
 */
export function isLeakedSupplementDecline(message: StoredMessage, supplementId?: string): boolean {
  const marker = message.extra?.supplement;
  if (!marker || (supplementId && marker.supplementId !== supplementId)) return false;
  return message.content.trim().startsWith(SUPPLEMENT_DECLINE_MARKER);
}

/**
 * Rebuild browser truth for historical records produced while the Stop hook
 * accidentally committed a decline marker as cat speech. The durable record
 * remains untouched; every hydration surface projects the same honest
 * "checked, no supplement needed" result.
 */
export async function projectFreshnessSupplementForHistory(
  supplement: FreshnessSupplementAggregate,
  messageStore?: IMessageStore,
): Promise<FreshnessSupplementProjection> {
  const projection = projectFreshnessSupplement(supplement);
  if (supplement.status !== 'committed' || !supplement.committedMessageId || !messageStore) return projection;

  const committedMessage = await messageStore.getById(supplement.committedMessageId);
  if (!committedMessage || !isLeakedSupplementDecline(committedMessage, supplement.id)) return projection;

  const { committedMessageId: _controlMessageId, ...recovered } = projection;
  return {
    ...recovered,
    status: 'declined',
    terminalReason: 'checked_no_supplement_needed',
  };
}
