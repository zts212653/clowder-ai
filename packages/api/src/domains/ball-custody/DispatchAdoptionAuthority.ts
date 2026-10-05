import { getQueueReadEvidence } from '../cats/services/agents/invocation/QueueReadEvidence.js';
import { isDispatchSource } from '../cats/services/agents/invocation/queue-source-completion-policy.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import type { LiveCompanionSessions } from '../concierge/live/LiveCompanionSessions.js';
import {
  type A2ADispatchDispositionAuth,
  A2ADispatchDispositionError,
  type DispatchAdoptionProof,
  type ReadEvidenceWitness,
} from './A2ADispatchDispositionService.js';
import type { TurnCustodyAdoptionRegistry } from './TurnCustodyAdoptionRegistry.js';

interface Dependencies {
  executions: Pick<ITurnExecutionStore, 'get'>;
  messages: Pick<IMessageStore, 'getById'>;
  adoptions: TurnCustodyAdoptionRegistry;
  live?: Pick<LiveCompanionSessions, 'withCarrierOperation'>;
}

/** Carrier admission is separate from the exact dispatch event writer and its receipt projection. */
export class DispatchAdoptionAuthority {
  constructor(private readonly deps: Dependencies) {}

  async run<T>(
    auth: A2ADispatchDispositionAuth,
    messageId: string,
    consume: (proof: DispatchAdoptionProof) => Promise<T>,
  ): Promise<T> {
    const execution = await this.assertExecution(auth);
    if (execution.queueCompletionPolicy === 'explicit_source') {
      if (!this.deps.live) throw new A2ADispatchDispositionError('adopted_dispatch_unavailable');
      // A closing Live carrier never falls through to ordinary admission.
      return this.deps.live.withCarrierOperation(auth, async () => {
        const witness = await getQueueReadEvidence(this.deps.messages, { ...auth, messageId });
        if (!witness) throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
        return consume({ carrierKind: 'live', witness });
      });
    }
    if (!this.deps.adoptions.isAccepting(auth.invocationId))
      throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
    return this.deps.adoptions.withOperation(auth, async (lease) => {
      await this.assertExecution(auth);
      if (!lease.matches(auth)) throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
      return consume({
        carrierKind: 'ordinary',
        witness: await this.readOrdinarySource(auth, messageId),
        assertSourceCurrent: async () => {
          await this.readOrdinarySource(auth, messageId);
        },
      });
    });
  }

  async candidates(auth: A2ADispatchDispositionAuth, messageIds: readonly string[]): Promise<string[]> {
    const execution = await this.assertExecution(auth);
    if (execution.queueCompletionPolicy === 'explicit_source' || !this.deps.adoptions.isAccepting(auth.invocationId))
      return [];
    const candidates: string[] = [];
    for (const id of new Set(messageIds)) {
      try {
        await this.readOrdinarySource(auth, id);
        const message = await this.deps.messages.getById(id);
        if (!message?.queueCustody?.handledByCatIds.includes(auth.catId)) candidates.push(id);
      } catch (error) {
        if (!(error instanceof A2ADispatchDispositionError)) throw error;
      }
    }
    return candidates;
  }

  private async assertExecution(auth: A2ADispatchDispositionAuth) {
    const execution = await this.deps.executions.get(auth.invocationId);
    if (
      !auth.userId ||
      !execution ||
      execution.status !== 'running' ||
      execution.userId !== auth.userId ||
      execution.threadId !== auth.threadId ||
      execution.catId !== auth.catId
    ) {
      throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
    }
    return execution;
  }

  private async readOrdinarySource(auth: A2ADispatchDispositionAuth, messageId: string): Promise<ReadEvidenceWitness> {
    const message = await this.deps.messages.getById(messageId);
    const custody = message?.queueCustody;
    if (
      !message ||
      message.deletedAt ||
      !custody ||
      message.threadId !== auth.threadId ||
      (custody.ownerUserId ?? message.userId) !== auth.userId ||
      !isDispatchSource(message, auth.catId) ||
      !custody.allTargetCats.includes(auth.catId) ||
      custody.withdrawnByCatIds?.includes(auth.catId) ||
      message.deliveryStatus === 'canceled'
    ) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_mismatch');
    }
    const exposure = custody.bodyExposures?.find(
      (e) => e.targetCatId === auth.catId && e.invocationId === auth.invocationId,
    );
    if (!exposure) throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    return { messageId, seenAt: exposure.seenAt, evidenceKind: 'queued_body_exposure' };
  }
}
