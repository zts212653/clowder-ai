import {
  DEVELOPMENT_RETURN_TEMPLATE_ID,
  type DevelopmentReturnActionV1,
  type DevelopmentReturnRegistrationV1,
} from '@cat-cafe/shared';
import type { ActionSuccessorLeaseStore } from '../../../domains/ball-custody/ActionSuccessorLeaseStore.js';
import type { PersistedQueueDeliveryPort } from '../../../domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import type { OwnerAuthProvenance } from '../../../domains/cats/services/owner-auth-provenance.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { IMessageStore } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { deriveGrowingSourceMessageRevision } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../../../domains/cats/services/stores/ports/ProposalStore.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStoreContract.js';
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type {
  RecordedReviewProof,
  RecordedReviewQuery,
} from '../../capability-evolution/adapters/request-review/request-review-provenance.js';
import type { DynamicTaskStore } from '../DynamicTaskStore.js';
import type { TaskRunnerV2 } from '../TaskRunnerV2.js';
import { createDevelopmentReturnTemplate } from '../templates/development-return.js';
import type { ExecuteContext } from '../types.js';
import {
  developmentReturnCurrentRevision,
  prepareDevelopmentReturn,
  resolveDevelopmentReturnFreshness,
} from './DevelopmentReturnAuthority.js';
import {
  isAdmissibleDevelopmentReturnReport,
  renderDevelopmentReturnWakeContentV1,
} from './DevelopmentReturnReportSource.js';
import { publishDevelopmentReturnRetirement } from './DevelopmentReturnRetirement.js';
import { parseDevelopmentReturnActionLeaseRef, sameDevelopmentReturnSource } from './DevelopmentReturnSource.js';

export interface DevelopmentReturnDeps {
  emit: (ownerUserId: string, event: string, data: unknown) => void;
  delivery: PersistedQueueDeliveryPort;
  definitions: DynamicTaskStore;
  runner: Pick<TaskRunnerV2, 'registerDynamic' | 'getRegisteredTasks' | 'triggerNow' | 'rescheduleOnce' | 'unregister'>;
  tasks: Pick<ITaskStore, 'get' | 'hasDevelopmentSource'>;
  threads: Pick<IThreadStore, 'get'>;
  proposals: Pick<IProposalStore, 'get'>;
  messages: Pick<IMessageStore, 'getById' | 'append'>;
  readReviewProvenance?: (query: RecordedReviewQuery) => Promise<RecordedReviewProof | null>;
  /** Exact returned generation used by sequential same-child reporter recovery. */
  actionSuccessors?: Pick<ActionSuccessorLeaseStore, 'get'>;
  now?: () => number;
}
type Registration = DevelopmentReturnRegistrationV1;
type DeliveryFreshnessClaim = { kind: 'current'; revision: number } | { kind: 'terminal'; state: Registration | null };
export class DevelopmentReturnService {
  readonly template = createDevelopmentReturnTemplate(this);
  constructor(readonly deps: DevelopmentReturnDeps) {}
  now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  read(id: string): Registration | null {
    return this.deps.definitions.getPrivateExecutionReturn(id);
  }

  async register(
    actor: DevelopmentWorkActor,
    input: DevelopmentReturnActionV1,
    proof: OwnerAuthProvenance,
  ): Promise<Registration> {
    const now = this.now();
    const { registration, returnStorage, predecessorSupersession } = await prepareDevelopmentReturn(
      this.deps,
      actor,
      input,
      now,
    );
    const id = registration.registrationId;
    const old = this.read(id);
    if (old) {
      if (!sameDevelopmentReturnSource(old, registration)) throw new Error('Return source changed after registration');
      if (old.slaUntil !== input.slaUntil || old.observedRevision !== registration.observedRevision)
        throw new Error('This exact return binding already has a different SLA or revision');
      this.ensureScheduled(id);
      return old;
    }
    this.deps.definitions.insert(
      {
        id,
        templateId: DEVELOPMENT_RETURN_TEMPLATE_ID,
        trigger: { type: 'once', fireAt: registration.slaUntil },
        params: {},
        display: { label: '等待开发结果回流', category: 'system', subjectKind: 'none' },
        deliveryThreadId: actor.threadId,
        createdBy: actor.catId,
        createdAt: new Date(now).toISOString(),
        enabled: true,
      },
      proof,
      registration,
      returnStorage,
      predecessorSupersession,
    );
    if (predecessorSupersession) this.deps.runner.unregister(predecessorSupersession.registrationId);
    this.ensureScheduled(id);
    return registration;
  }

  private ensureScheduled(id: string): void {
    const def = this.deps.definitions.getById(id);
    if (!def?.enabled || this.deps.runner.getRegisteredTasks().includes(id)) return;
    this.deps.runner.registerDynamic(
      this.template.createSpec(id, { trigger: def.trigger, params: {}, deliveryThreadId: def.deliveryThreadId }),
      id,
    );
  }

  readForActor(actor: DevelopmentWorkActor, id?: string): unknown {
    const states = id
      ? [this.read(id)].filter((value): value is Registration => value !== null)
      : this.deps.definitions.findPrivateExecutionReturns(actor.threadId);
    return states
      .filter((state) => state.ownerUserId === actor.userId)
      .flatMap((state) => {
        if (state.ownerThreadId === actor.threadId && state.ownerCatId === actor.catId) return [state];
        if (state.executionThreadId !== actor.threadId || !state.reporterCatIds.includes(actor.catId)) return [];
        // Child execution receives reporting coordinates, never the original Task's owner projection.
        return [
          {
            registrationId: state.registrationId,
            expectedSignal: state.expectedSignal,
            slaUntil: state.slaUntil,
            sourceActionRef: state.sourceActionRef,
            status: state.status,
          },
        ];
      });
  }

  async report(
    actor: DevelopmentWorkActor,
    id: string,
    report: NonNullable<DevelopmentReturnActionV1['report']>,
  ): Promise<{ status: string }> {
    const state = this.read(id);
    if (
      !state ||
      state.ownerUserId !== actor.userId ||
      state.executionThreadId !== actor.threadId ||
      !state.reporterCatIds.includes(actor.catId)
    )
      throw new Error('Return registration is unavailable here');
    if (
      parseDevelopmentReturnActionLeaseRef(state.sourceActionRef) &&
      (await developmentReturnCurrentRevision(this.deps, state)) === null
    ) {
      throw new Error('Return reporter authority is no longer current');
    }
    const predecessor = state.predecessorRegistrationId ? this.read(state.predecessorRegistrationId) : null;
    const [message, predecessorWake] = await Promise.all([
      this.deps.messages.getById(report.sourceMessageId),
      predecessor?.wakeMessageId ? this.deps.messages.getById(predecessor.wakeMessageId) : null,
    ]);
    if (!isAdmissibleDevelopmentReturnReport(message, state, actor.catId, predecessor, predecessorWake))
      throw new Error('A current persisted terminal report from this execution is required');
    const publication = { ...report, sourceMessageRevision: deriveGrowingSourceMessageRevision(message) };
    if (state.report && JSON.stringify(state.report) !== JSON.stringify(publication))
      throw new Error('Return already has a different terminal report');
    if (state.status === 'retired' || state.status === 'delivered') return this.reportState(id);
    if (state.reason === 'owner_changed') return { status: 'retirement_pending' };
    if (state.status === 'delivering' && !state.report) return { status: 'requires_owner_successor' };
    if (state.status === 'waiting') {
      this.deps.definitions.replacePrivateExecutionReturn(id, state, {
        ...state,
        status: 'ready',
        report: publication,
        reason: 'terminal_report',
      });
    }
    this.ensureScheduled(id);
    this.deps.runner.rescheduleOnce(id, this.now());
    await this.deps.runner.triggerNow(id);
    return this.reportState(id);
  }

  private reportState(id: string): { status: string } {
    const state = this.read(id);
    if ((state?.status === 'delivered' || state?.status === 'delivering') && !state.report) {
      return { status: 'requires_owner_successor' };
    }
    return { status: state?.status ?? 'unavailable' };
  }

  retireUndelivered(id: string): void {
    const state = this.read(id);
    if (!state || state.status === 'delivered' || state.status === 'retired') return;
    this.deps.definitions.replacePrivateExecutionReturn(id, state, {
      ...state,
      status: 'retired',
      reason: 'delivery_failed',
    });
  }

  private async claimDeliveryFreshness(id: string, state: Registration): Promise<DeliveryFreshnessClaim> {
    const freshness = await resolveDevelopmentReturnFreshness(this.deps, state);
    if (freshness.kind === 'current') return { kind: 'current', revision: freshness.revision };
    if (freshness.kind === 'superseded') {
      const next = {
        ...state,
        status: 'retired' as const,
        reason: 'superseded' as const,
      };
      this.deps.definitions.replacePrivateExecutionReturn(id, state, next);
      return { kind: 'terminal', state: null };
    }
    const next = {
      ...state,
      status: 'delivering' as const,
      reason: 'owner_changed' as const,
    };
    return {
      kind: 'terminal',
      state: this.deps.definitions.replacePrivateExecutionReturn(id, state, next) ? next : null,
    };
  }

  private async claimDelivery(id: string): Promise<Registration | null> {
    let state = this.read(id);
    if (!state || state.status === 'retired' || state.status === 'delivered') return null;
    if (state.status === 'delivering' && state.reason === 'owner_changed') return state;
    const freshness = await this.claimDeliveryFreshness(id, state);
    if (freshness.kind === 'terminal') return freshness.state;
    const currentRevision = freshness.revision;
    if (state.status !== 'delivering') {
      if (state.status === 'waiting' && this.now() < state.slaUntil) return null;
      const next = {
        ...state,
        status: 'delivering' as const,
        deliveryRevision: currentRevision,
        reason: state.report ? ('terminal_report' as const) : ('deadline_review' as const),
      };
      if (!this.deps.definitions.replacePrivateExecutionReturn(id, state, next)) return null;
      state = next;
    }
    return state;
  }

  async execute(id: string, ctx: ExecuteContext): Promise<void> {
    ctx.signal.throwIfAborted();
    const state = await this.claimDelivery(id);
    if (!state) return;
    if (state.reason === 'owner_changed') {
      // A readable cancellation receipt never dispatches revoked work. Persist before terminal CAS;
      // retries reuse the Message owner's idempotency key, including after a process crash.
      await publishDevelopmentReturnRetirement(this.deps, state, this.now(), ctx.signal);
      this.deps.definitions.replacePrivateExecutionReturn(id, state, { ...state, status: 'retired' });
      return;
    }
    const content = renderDevelopmentReturnWakeContentV1(state);
    ctx.signal.throwIfAborted();
    // Dispatch owns message admission, replay and terminal custody; the producer never mints a second wake.
    const result = await this.deps.delivery.deliver({
      ownerUserId: state.ownerUserId,
      threadId: state.ownerThreadId,
      targetCatId: state.ownerCatId,
      ownerAuthProvenance: this.deps.definitions.getPrivateOwnerAuthProvenance(id),
      idempotencyKey: `${id}:owner-return`,
      content,
      sourceCategory: 'producer_return',
      source: {
        connector: 'development-return',
        label: '开发结果回流',
        icon: 'cat-cafe',
        meta: {
          registrationId: id,
          taskRef: state.taskRef,
          observedRevision: String(state.observedRevision),
          currentRevision: String(state.deliveryRevision),
          reason: state.reason ?? '',
        },
      },
    });
    if (result.state === 'unavailable' || result.state === 'conflict' || !result.message) {
      throw new Error('Original owner return has not been accepted by durable Dispatch');
    }
    const withdrawn = result.message.deliveryStatus === 'canceled';
    const final = withdrawn
      ? {
          ...state,
          status: 'retired' as const,
          reason: 'cancelled' as const,
        }
      : { ...state, status: 'delivered' as const };
    if (
      this.deps.definitions.replacePrivateExecutionReturn(id, state, { ...final, wakeMessageId: result.message.id })
    ) {
      const message = result.message;
      this.deps.emit(state.ownerUserId, 'messages_queued', {
        threadId: state.ownerThreadId,
        messageIds: [message.id],
        messages: [
          {
            id: message.id,
            from: message.from,
            lifecycle: message.lifecycle,
            deliveryStatus: message.deliveryStatus,
            content: message.content,
            catId: message.catId,
            timestamp: message.timestamp,
            mentions: message.mentions,
            userId: message.userId,
            source: message.source,
            extra: message.extra,
          },
        ],
      });
    }
  }
}
