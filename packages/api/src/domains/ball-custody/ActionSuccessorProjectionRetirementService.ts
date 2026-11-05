import type {
  ActionSuccessorQueueRetirement,
  InvocationQueue,
} from '../cats/services/agents/invocation/InvocationQueue.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import { buildActionSuccessorFence } from './ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

interface QueuePublication {
  threadId: string;
  userId: string;
  receiptMessageIds: string[];
}

interface ActionSuccessorProjectionRetirementDeps {
  invocationQueue: Pick<InvocationQueue, 'listActionSuccessorFence' | 'retireActionSuccessorFenceDurable'>;
  taskStore: Pick<ITaskStore, 'getBySubject' | 'replaceAutomationStateIfGeneration'>;
  publishQueue: (publication: QueuePublication) => Promise<void>;
}

function publicationKey(publication: QueuePublication): string {
  return JSON.stringify([publication.threadId, publication.userId]);
}

/**
 * Projects one completed fenced decision into Queue custody.
 * It owns no truth: each projection is exact-fence CAS/idempotent and replayed
 * from the immutable completed lease after any crash window.
 */
export class ActionSuccessorProjectionRetirementService {
  constructor(private readonly deps: ActionSuccessorProjectionRetirementDeps) {}

  async retire(lease: ActionSuccessorLease): Promise<void> {
    if (lease.status !== 'completed') return;
    await this.retireQueue(lease);
  }

  private async retireQueue(lease: ActionSuccessorLease): Promise<void> {
    const fence = buildActionSuccessorFence(lease, lease.dispatchId);
    const processCandidates = this.deps.invocationQueue.listActionSuccessorFence(fence);
    const durableRetirements = await this.deps.invocationQueue.retireActionSuccessorFenceDurable(fence);
    const publications = this.queuePublications([...processCandidates, ...durableRetirements]);
    await Promise.all([...publications.values()].map((publication) => this.deps.publishQueue(publication)));
  }

  private queuePublications(retirements: ActionSuccessorQueueRetirement[]): Map<string, QueuePublication> {
    const publications = new Map<string, QueuePublication>();
    const add = (threadId: string, userId: string, messageIds: readonly string[]): void => {
      const key = publicationKey({ threadId, userId, receiptMessageIds: [] });
      const current = publications.get(key);
      publications.set(key, {
        threadId,
        userId,
        receiptMessageIds: [...new Set([...(current?.receiptMessageIds ?? []), ...messageIds])],
      });
    };
    for (const retired of retirements) add(retired.threadId, retired.userId, retired.messageIds);
    return publications;
  }
}
