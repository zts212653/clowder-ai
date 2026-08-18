import type {
  DeferredPersonMemoryReceipt,
  DeferredPersonMemoryResolvedSource,
  WriteOpportunityReentryCarrierV1,
} from '@cat-cafe/shared';

export interface DeferredPersonMemoryDailySignal {
  receiptId: string;
  ownerUserId: string;
  requesterCatId: string;
  originMessageRef: { kind: 'message'; threadId: string; messageId: string };
  subject: string;
  registryBinding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>;
  sourceCoordinates: DeferredPersonMemoryResolvedSource[];
  state: 'claimed';
  claimId: string;
  claimUntil: number;
  writeOpportunityLineage?: DeferredPersonMemoryReceipt['writeOpportunityLineage'];
  writeOpportunityReentry?: WriteOpportunityReentryCarrierV1;
}

function coordinateText(source: DeferredPersonMemoryResolvedSource): string {
  const base = `${source.sourceRef.threadId}#${source.sourceRef.messageId}`;
  if (source.kind === 'message') return `message ${base}`;
  const confirmation = source.confirmationSourceRef
    ? ` confirmed-by ${source.confirmationSourceRef.threadId}#${source.confirmationSourceRef.messageId}`
    : ' unconfirmed';
  return `attachment ${base} ${source.attachmentLocator.surface}[${source.attachmentLocator.index}]${confirmation}`;
}

/** IDs-only attribution for a Standing Reflex write opportunity that re-entered after defer. */
function writeOpportunityReentryText(signal: DeferredPersonMemoryDailySignal): string {
  const lineage = signal.writeOpportunityLineage;
  if (!lineage) return '';
  return (
    `write-opportunity lineage: reflex=${lineage.reflexId} v${lineage.reflexVersion} ` +
    `sourceOpportunityId=${lineage.opportunityId} lineage=${lineage.dedupeLineage} priorGeneration=${lineage.generation}\n` +
    'The server has mechanically re-entered the next generation through F296. Use the exact writeOpportunityRef ' +
    'printed in the write-opportunity prompt for propose, defer, or abstain; all lanes remain on F276.CaptureCandidate.v1. ' +
    `If deferring again, also pass reentryReceipt={receiptId:${signal.receiptId},claimId:${signal.claimId}} so this same receipt is re-armed instead of creating another one.\n`
  );
}

export function deferredPersonMemoryTriggerContent(signal: DeferredPersonMemoryDailySignal): string {
  const coordinates = signal.sourceCoordinates.map(coordinateText).join('\n- ');
  return (
    '[F276 deferred person-memory daily clerk]\n' +
    writeOpportunityReentryText(signal) +
    `receiptId=${signal.receiptId}\n` +
    `claimId=${signal.claimId}\n` +
    `subject=${JSON.stringify(signal.subject)}\n` +
    `registry=${signal.registryBinding.kind}:${signal.registryBinding.ref}\n` +
    `exact sources:\n- ${coordinates}\n\n` +
    'Read only these exact owner-visible sources. Do not scan thread history or all conversations. ' +
    'If they support a useful known-person delta, create one ordinary rejectable F276 proposal with a complete typed sourceBundle, ' +
    `deferredReceipt={receiptId:${signal.receiptId},claimId:${signal.claimId}}, and clientRequestId=${signal.receiptId}. ` +
    'Never materialize memory directly. Never turn the correction/capture itself into an interaction event. ' +
    'If evidence is insufficient or an attachment/ASR lacks explicit owner confirmation, do not propose; let the claim expire for later resolution.'
  );
}
