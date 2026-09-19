import type { CatRoutingError, MessageFrom, QueueAuthorIntent, WaitContinuationCarrierV1 } from '@cat-cafe/shared';
import type { CallerTraceContext } from '../../../../../../infrastructure/telemetry/genai-semconv.js';
import type { ActionSuccessorFence } from '../../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type { CloudDispatchProvenance } from '../../../cloud-bridge/types.js';
import type { ToolExecutionPolicy } from '../../../types.js';
import type { OwnerAuthProvenance } from '../owner-auth-provenance.js';
import { type QueueLedgerEntry, type QueueOwner, queueEntryId } from './QueueLedger.js';

export interface QueueLedgerAdmissionInput {
  sourceId: string;
  threadId: string;
  owner: QueueOwner;
  kind: QueueLedgerEntry['kind'];
  from: MessageFrom;
  targetCatIds: readonly string[];
  content: string;
  messageId?: string;
  routingWarnings?: readonly CatRoutingError[];
  authorIntentByCatId?: Readonly<Record<string, QueueAuthorIntent>>;
  intent: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  autoExecute?: boolean;
  priority?: QueueLedgerEntry['priority'];
  sourceCategory?: QueueLedgerEntry['sourceCategory'];
  a2aParentInvocationId?: string;
  freshnessClosureId?: string;
  freshnessSupplementId?: string;
  freshnessSupplementLineageId?: string;
  freshnessSupplementSeq?: 1 | 2;
  readOnlyToolPolicy?: ToolExecutionPolicy;
  actionSuccessorFence?: ActionSuccessorFence;
  waitContinuationCarrier?: WaitContinuationCarrierV1;
  suggestedSkill?: string;
  callerTraceContext?: CallerTraceContext;
  a2aTriggerMessageId?: string;
  cloudDispatchProvenance?: CloudDispatchProvenance;
  requiresExactCloudDispatchProvenance?: boolean;
  enqueuedAt: number;
}

export function createQueueLedgerAdmission(input: QueueLedgerAdmissionInput): QueueLedgerEntry[] {
  if (!input.sourceId) throw new Error('Queue admission requires a persistent source id');
  if (input.targetCatIds.length === 0 && input.kind !== 'conversation_input') {
    throw new Error(`${input.kind} Queue admission requires an exact target`);
  }
  if (new Set(input.targetCatIds).size !== input.targetCatIds.length) {
    throw new Error('Queue admission targets must be unique');
  }
  return [
    {
      version: 2,
      id: queueEntryId(input.sourceId),
      threadId: input.threadId,
      owner: structuredClone(input.owner),
      kind: input.kind,
      from: structuredClone(input.from),
      targets: [...input.targetCatIds],
      payload: {
        sourceRecordId: input.sourceId,
        content: input.content,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.routingWarnings?.length ? { routingWarnings: structuredClone(input.routingWarnings) } : {}),
      },
      execution: {
        intent: input.intent,
        ownerAuthProvenance: input.ownerAuthProvenance,
        autoExecute: input.autoExecute ?? false,
        ...(input.a2aParentInvocationId ? { a2aParentInvocationId: input.a2aParentInvocationId } : {}),
        ...(input.freshnessClosureId ? { freshnessClosureId: input.freshnessClosureId } : {}),
        ...(input.freshnessSupplementId ? { freshnessSupplementId: input.freshnessSupplementId } : {}),
        ...(input.freshnessSupplementLineageId
          ? { freshnessSupplementLineageId: input.freshnessSupplementLineageId }
          : {}),
        ...(input.freshnessSupplementSeq ? { freshnessSupplementSeq: input.freshnessSupplementSeq } : {}),
        ...(input.readOnlyToolPolicy ? { readOnlyToolPolicy: structuredClone(input.readOnlyToolPolicy) } : {}),
        ...(input.actionSuccessorFence ? { actionSuccessorFence: structuredClone(input.actionSuccessorFence) } : {}),
        ...(input.waitContinuationCarrier
          ? { waitContinuationCarrier: structuredClone(input.waitContinuationCarrier) }
          : {}),
        ...(input.suggestedSkill ? { suggestedSkill: input.suggestedSkill } : {}),
        ...(input.callerTraceContext ? { callerTraceContext: structuredClone(input.callerTraceContext) } : {}),
        ...(input.a2aTriggerMessageId ? { a2aTriggerMessageId: input.a2aTriggerMessageId } : {}),
        ...(input.cloudDispatchProvenance
          ? { cloudDispatchProvenance: structuredClone(input.cloudDispatchProvenance) }
          : {}),
        ...(input.requiresExactCloudDispatchProvenance ? { requiresExactCloudDispatchProvenance: true } : {}),
      },
      delivery: {
        ...(input.authorIntentByCatId && Object.keys(input.authorIntentByCatId).length > 0
          ? { authorIntentByTarget: structuredClone(input.authorIntentByCatId) }
          : {}),
      },
      status: 'queued',
      enqueuedAt: input.enqueuedAt,
      priority: input.priority ?? 'normal',
      ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
    },
  ];
}
