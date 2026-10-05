import type { DispatchReceiptService } from '../../ball-custody/DispatchReceiptService.js';
import { getQueueReadEvidence } from '../../cats/services/agents/invocation/QueueReadEvidence.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { LiveCompanionSessions } from './LiveCompanionSessions.js';

/** The Host supplies all adopted-dispatch dependencies as one authority boundary. */
export function liveDispatchAdoption(deps: {
  sessions: LiveCompanionSessions;
  receipts: DispatchReceiptService;
  messageStore: IMessageStore;
}) {
  return {
    isLiveCarrierInvocation: deps.sessions.isActiveCarrier.bind(deps.sessions),
    getReadEvidenceForMessage: (query: Parameters<typeof getQueueReadEvidence>[1]) =>
      getQueueReadEvidence(deps.messageStore, query),
    withLiveCarrierOperation: deps.sessions.withCarrierOperation.bind(deps.sessions),
    projectAdoptedDisposition: async (input: { threadId: string; catId: string; sourceMessageId: string }) => {
      if (!(await deps.receipts.repair(input))) throw new Error('Dispatch terminal missing after completion');
    },
  };
}
