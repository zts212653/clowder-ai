import type { AutomationState } from '@cat-cafe/shared';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface ProposalRoutesOptions {
  proposalStore: IProposalStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
  router?: Pick<AgentRouter, 'resolveTargetsAndIntent'>;
  invocationQueue?: Pick<InvocationQueue, 'enqueue' | 'backfillMessageId' | 'rollbackEnqueue'>;
  queueProcessor?: Pick<QueueProcessor, 'processNext'>;
  taskStore?: Pick<ITaskStore, 'getBySubject' | 'upsertBySubject'>;
  fetchPrTrackingBoundary?: (repoFullName: string, prNumber: number) => Promise<Pick<AutomationState, 'review' | 'ci'>>;
  onProposalReject?: (input: {
    proposalId: string;
    catId: string;
    threadId: string;
    proposalTitle?: string;
    rejectionReason?: string;
  }) => void;
}
