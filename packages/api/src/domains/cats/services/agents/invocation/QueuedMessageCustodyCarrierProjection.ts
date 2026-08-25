import type { QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';

function carrierEntryId(custody: QueuedMessageCustody, catId: string): string | undefined {
  return custody.carrierByTargetCatId?.[catId]?.entryId ?? custody.entryId;
}

export function isQueuedCarrierTarget(custody: QueuedMessageCustody, catId: string): boolean {
  const carrierState = custody.carrierStateByTargetCatId?.[catId];
  if (carrierState) return carrierState.status === 'queued';
  return custody.status === 'queued';
}

export function queuedCarrierOwnsPendingTarget(custody: QueuedMessageCustody, entryId: string): boolean {
  return custody.pendingTargetCats.some(
    (catId) => carrierEntryId(custody, catId) === entryId && isQueuedCarrierTarget(custody, catId),
  );
}

export function activeCarrierEntryIds(message: StoredMessage): string[] {
  const custody = message.queueCustody;
  if (!custody) return [];
  return [
    ...new Set(
      custody.pendingTargetCats.flatMap((catId) => {
        const entryId = carrierEntryId(custody, catId);
        return entryId ? [entryId] : [];
      }),
    ),
  ];
}

export function queuedCarrierEntryIds(message: StoredMessage): string[] {
  const custody = message.queueCustody;
  if (!custody) return [];
  return [
    ...new Set(
      custody.pendingTargetCats.flatMap((catId) => {
        if (!isQueuedCarrierTarget(custody, catId)) return [];
        const entryId = carrierEntryId(custody, catId);
        return entryId ? [entryId] : [];
      }),
    ),
  ];
}
