import { createHash } from 'node:crypto';
import { type ContextSourceEvidenceV1, contextSourceEvidenceV1Schema, type RecallScopeV1 } from '@cat-cafe/shared';
import type { ActionSuccessorFence } from '../../ball-custody/ActionSuccessorAdmissionContract.js';
import type { ActionSuccessorLeaseStore } from '../../ball-custody/ActionSuccessorLeaseStore.js';
import type { TaskApprovedDelegateProvider } from '../../ball-custody/action-subject-delegate-contract.js';
import type {
  ContextEpochState,
  ContextEpochTransition,
} from '../../cats/services/session/context/ContextEpochOwner.js';
import { contextEpochScopeKey } from '../../cats/services/session/context/ContextEpochOwner.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { ContinuityDisposition } from '../../cats/services/types.js';
import { resolveEntrustedWorkTaskRefFromSource } from '../../growing/EntrustedWorkRuntimeInteractionBinding.js';
import { resolveTaskExecutionBinding } from '../../growing/EntrustedWorkTaskExecutionBinding.js';
import { type ContextSourceOpportunityRecord, ContextSourceOpportunityStore } from './ContextSourceOpportunityStore.js';
import type { ContextSourceOmission } from './context-source-omission.js';
import type { MemoryCueOpportunitySeed } from './MemoryCueInvocationPromptService.js';

/** Only Queue/first-party ingress builds this frame. No HTTP/MCP field accepts it. */
export interface ContextSourceIngress {
  kind: 'owner' | 'queue_agent';
  sourceMessageId: string;
  actionSuccessorFence?: ActionSuccessorFence;
}
export interface ContextSourceDecision extends ContextEpochState {
  transition: ContextEpochTransition;
  normalizedDisposition: ContinuityDisposition;
}
export interface ContextSourceAdmissionInput {
  scope: RecallScopeV1;
  consumerCatId: string;
  exactSourceMessageId?: string;
  ownerAuthProvenance?: string;
  ingress?: ContextSourceIngress;
  decision: ContextSourceDecision;
  now: number;
  signal?: AbortSignal;
}

export function contextSourceEvidence(decision: ContextSourceDecision): ContextSourceEvidenceV1 | null {
  const d = decision.normalizedDisposition;
  const transition = decision.transition;
  if ((transition === 'fresh' || transition === 'scope_first_seen') && d.state === 'fresh') {
    if (d.runtimeSessionId && d.runtimeSessionId !== decision.boundRuntimeSessionId) return null;
    const result = contextSourceEvidenceV1Schema.safeParse({
      transition,
      reason: d.reason,
      evidenceRef: d.evidenceRef,
      ...(d.runtimeSessionId ? { runtimeSessionId: d.runtimeSessionId } : {}),
    });
    return result.success ? result.data : null;
  }
  if (transition === 'replaced' && d.state === 'replaced' && d.runtimeSessionId === decision.boundRuntimeSessionId) {
    return { transition, reason: 'runtime_replaced', evidenceRef: d.evidenceRef, runtimeSessionId: d.runtimeSessionId };
  }
  if (transition === 'context_compacted' && decision.boundRuntimeSessionId) {
    const eventId = decision.consumedCompactionEventIds.at(-1);
    if (eventId && decision.lastTransitionRef) {
      const result = contextSourceEvidenceV1Schema.safeParse({
        transition,
        eventId,
        evidenceRef: decision.lastTransitionRef,
        runtimeSessionId: decision.boundRuntimeSessionId,
      });
      return result.success ? result.data : null;
    }
  }
  return null;
}

export class ContextSourceAdmission {
  constructor(
    private readonly deps: {
      messages: Pick<IMessageStore, 'getById'>;
      threads: Pick<IThreadStore, 'get'>;
      tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
      leases?: Pick<ActionSuccessorLeaseStore, 'get'>;
      delegates?: TaskApprovedDelegateProvider;
      store: ContextSourceOpportunityStore;
      onOmission?(sourceMessageId: string, reason: ContextSourceOmission): void;
    },
  ) {}

  async prepare(input: ContextSourceAdmissionInput): Promise<MemoryCueOpportunitySeed | null> {
    input.signal?.throwIfAborted();
    const { ingress, decision, scope, consumerCatId } = input;
    if (input.ownerAuthProvenance !== 'strict' || !ingress || ingress.sourceMessageId !== input.exactSourceMessageId)
      return null;
    if (
      decision.scopeKey !==
      contextEpochScopeKey({ userId: scope.ownerUserId, catId: consumerCatId, threadId: scope.threadId })
    )
      return null;
    const existing = this.deps.store.find(
      decision.scopeKey,
      decision.contextEpoch,
      ingress.sourceMessageId,
      consumerCatId,
    );
    const edge = contextSourceEvidence(decision);
    if (!edge && !existing) return null;
    const authorityDigest = await this.authority(scope, consumerCatId, ingress);
    if (!authorityDigest) return null;
    const variant = ingress.kind === 'owner' ? 'fresh_context_sources' : 'authorized_task_sources';
    if (existing) {
      if (
        existing.committed ||
        existing.expiresAt <= input.now ||
        existing.variant !== variant ||
        existing.authorityDigest !== authorityDigest
      )
        return null;
      const evidence = edge;
      const retry = decision.transition === 'resumed' || decision.transition === 'context_compaction_replay';
      if (!evidence && !retry) return null;
      if (existing.evidence.runtimeSessionId && existing.evidence.runtimeSessionId !== decision.boundRuntimeSessionId)
        return null;
      if (evidence && JSON.stringify(evidence) !== JSON.stringify(existing.evidence)) return null;
      return this.seed(existing);
    }
    const evidence = edge;
    if (!evidence) return null;
    input.signal?.throwIfAborted();
    const digest = createHash('sha256')
      .update(
        [variant, decision.scopeKey, decision.contextEpoch, JSON.stringify(evidence), ingress.sourceMessageId].join(
          '\0',
        ),
      )
      .digest('hex')
      .slice(0, 40);
    const record = this.deps.store.prepare({
      opportunityId: `memory-cue-opportunity-${digest}`,
      variant,
      scopeKey: decision.scopeKey,
      contextEpoch: decision.contextEpoch,
      sourceMessageId: ingress.sourceMessageId,
      consumerCatId,
      evidence,
      occurredAt: input.now,
      expiresAt: input.now + 300000,
      committed: false,
      ingress,
      authorityDigest,
    });
    return record && !record.committed ? this.seed(record) : null;
  }

  /** Rebind original Queue/Task and project facts at final submit and again at drill. */
  async validate(opportunityId: string, scope: RecallScopeV1, consumerCatId: string, now: number): Promise<boolean> {
    const record = this.deps.store.get(opportunityId);
    if (
      !record ||
      record.expiresAt <= now ||
      record.consumerCatId !== consumerCatId ||
      record.scopeKey !==
        contextEpochScopeKey({ userId: scope.ownerUserId, catId: consumerCatId, threadId: scope.threadId })
    )
      return false;
    return (await this.authority(scope, consumerCatId, record.ingress)) === record.authorityDigest;
  }

  private async authority(
    scope: RecallScopeV1,
    consumerCatId: string,
    ingress: ContextSourceIngress,
  ): Promise<string | null> {
    const source = await this.deps.messages.getById(ingress.sourceMessageId);
    const thread = await this.deps.threads.get(scope.threadId);
    if (source?.userId !== scope.ownerUserId || thread?.createdBy !== scope.ownerUserId) {
      this.deps.onOmission?.(ingress.sourceMessageId, 'owner_mismatch');
      return null;
    }
    if (
      !source ||
      source.deletedAt ||
      source._tombstone ||
      source.recall ||
      source.userId !== scope.ownerUserId ||
      source.threadId !== scope.threadId ||
      !thread ||
      thread.createdBy !== scope.ownerUserId ||
      (source.visibility === 'whisper' &&
        !source.revealedAt &&
        !source.whisperTo?.includes(consumerCatId as import('@cat-cafe/shared').CatId))
    ) {
      this.deps.onOmission?.(ingress.sourceMessageId, 'scope_unavailable');
      return null;
    }
    // Connector/system/schedule input cannot borrow a first-party or Task authority frame.
    if (source.source) return null;
    if (source.from && source.from.kind !== (ingress.kind === 'owner' ? 'user' : 'agent')) return null;
    if (ingress.kind === 'owner' && (source.catId !== null || source.source)) return null;
    const taskAuthority =
      ingress.kind === 'owner'
        ? 'owner'
        : source.catId
          ? await this.authorizeTask(scope, consumerCatId, ingress)
          : null;
    if (!taskAuthority) return null;
    return createHash('sha256')
      .update(
        JSON.stringify([
          source.id,
          source.userId,
          source.threadId,
          thread.projectPath,
          createHash('sha256').update(source.content).digest('hex'),
          taskAuthority,
        ]),
      )
      .digest('hex');
  }

  private seed(record: ContextSourceOpportunityRecord): MemoryCueOpportunitySeed {
    const base = {
      occurredAt: record.occurredAt,
      payload: {
        sourceMessageId: record.sourceMessageId,
        contextEpoch: record.contextEpoch,
        evidence: record.evidence,
      },
    };
    return record.variant === 'fresh_context_sources'
      ? { ...base, kind: record.variant, producer: 'context_epoch' }
      : { ...base, kind: record.variant, producer: 'task_action_custody' };
  }

  private async authorizeTask(
    scope: RecallScopeV1,
    consumerCatId: string,
    ingress: ContextSourceIngress,
  ): Promise<string | null> {
    const fence = ingress?.actionSuccessorFence;
    if (fence) {
      const lease = await this.deps.leases?.get(fence.leaseId);
      if (
        !lease ||
        lease.status !== 'active' ||
        lease.generation !== fence.generation ||
        lease.dispatchId !== fence.dispatchId ||
        (lease.dispatchDeliveredMessageId !== undefined &&
          lease.dispatchDeliveredMessageId !== ingress.sourceMessageId) ||
        !fence.terminalPredicateDigest ||
        lease.terminalPredicate?.digest !== fence.terminalPredicateDigest ||
        lease.tenantScope !== scope.ownerUserId ||
        lease.holderThreadId !== scope.threadId ||
        !lease.holderCatIds.includes(consumerCatId) ||
        !lease.subjectRef.startsWith('subject:task:')
      )
        return null;
      const task = await this.deps.tasks.get(lease.subjectRef.slice('subject:task:'.length));
      if (
        !task ||
        task.userId !== scope.ownerUserId ||
        task.status === 'done' ||
        (task.entrustedWork && task.entrustedWork.closure.state !== 'open')
      )
        return null;
      const binding = await resolveTaskExecutionBinding(task, lease, this.deps.delegates);
      return binding.kind === 'ready' &&
        binding.binding.catId === consumerCatId &&
        binding.binding.threadId === scope.threadId
        ? JSON.stringify([
            task.id,
            task.updatedAt,
            task.entrustedWork?.revision,
            // Queue serialization and schema decoding may reorder object keys without changing authority.
            [
              fence.leaseId,
              fence.generation,
              fence.dispatchId,
              fence.terminalPredicateDigest,
              fence.invocationLineageRef,
            ],
          ])
        : null;
    }
    const tasks = await this.deps.tasks.listByThread(scope.threadId);
    const ref = resolveEntrustedWorkTaskRefFromSource(tasks, {
      sourceMessageId: ingress!.sourceMessageId,
      ownerUserId: scope.ownerUserId,
      ownerCatId: consumerCatId as import('@cat-cafe/shared').CatId,
      threadId: scope.threadId,
    });
    if (!ref) return null;
    const task = await this.deps.tasks.get(ref.subjectRef.slice('task:work:'.length));
    return task?.entrustedWork?.closure.state === 'open' &&
      task.entrustedWork.revision === ref.observedRevision &&
      task.ownerCatId === consumerCatId &&
      task.threadId === scope.threadId &&
      task.userId === scope.ownerUserId &&
      task.status !== 'done'
      ? JSON.stringify([task.id, task.updatedAt, ref.observedRevision])
      : null;
  }
}
