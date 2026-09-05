import type {
  DeferredPersonMemoryReceipt,
  DeferredPersonMemoryResolvedSource,
  WriteOpportunityReentryCarrierV1,
} from '@cat-cafe/shared';

export interface DeferredPersonMemoryDailyBatchSignal {
  ownerUserId: string;
  receiptIds: string[];
}

export interface DeferredPersonMemoryDailyItem {
  receiptId: string;
  ownerUserId: string;
  originMessageRef: { kind: 'message'; threadId: string; messageId: string };
  subject: string;
  registryBinding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>;
  sourceCoordinates: DeferredPersonMemoryResolvedSource[];
  state: 'claimed';
  claimId: string;
  claimUntil: number;
  processorCatId: string;
  processingThreadId: string;
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
function writeOpportunityReentryText(signal: DeferredPersonMemoryDailyItem): string {
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

function receiptPacket(signal: DeferredPersonMemoryDailyItem, index: number): string {
  const coordinates = signal.sourceCoordinates.map(coordinateText).join('\n- ');
  return (
    `## receipt ${index + 1}\n` +
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
    'If an attachment/ASR lacks explicit owner confirmation, call cat_cafe_dispose_deferred_person_memory with disposition=awaiting_confirmation. ' +
    'If no useful explicit fact is supported, call it with disposition=insufficient_evidence. Never leave a receipt unresolved.'
  );
}

export function deferredPersonMemoryTriggerContent(signals: readonly DeferredPersonMemoryDailyItem[]): string {
  return (
    '[F276 unified Memory Operations clerk]\n' +
    `Process ${signals.length} independent receipt packet(s). This is one bounded batch, not one entity worker.\n` +
    'Read only each packet’s exact owner-visible sources. Do not scan thread history or all conversations. ' +
    'Never mix facts or source coordinates across packets. Complete every packet independently with one proposal or one explicit disposition.\n\n' +
    signals.map(receiptPacket).join('\n\n')
  );
}
