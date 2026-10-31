import type { ScheduleRunTiming } from '../../infrastructure/scheduler/types.js';
import { type AutoDreamStore, AutoDreamStoreError } from './AutoDreamStore.js';
import type { ProactiveRelationshipService, ProactiveWakeContext } from './ProactiveRelationshipService.js';
import { renderPersistedPresentLoopTrigger, renderPresentLoopPrompt } from './present-loop-contract.js';
import type {
  BeginPresentLoopRunResult,
  InvocationPrincipal,
  PresentLoopRunRecord,
  PresentLoopSettlementResult,
  SettlePresentLoopValue,
} from './store-types.js';

export interface DiaryProjectionReconciler {
  reconcile(ownerUserId: string): Promise<{ projected: number; removed: number; failed: number }>;
}

export interface BeginScheduledPresentLoopInput {
  ownerUserId: string;
  catId: string;
  threadId: string;
  taskId: string;
  schedule: ScheduleRunTiming;
}

export interface BeginScheduledPresentLoopResult extends BeginPresentLoopRunResult {
  proactiveContext: ProactiveWakeContext;
}

export class PresentLoopService {
  constructor(
    private readonly store: AutoDreamStore,
    private readonly projector: DiaryProjectionReconciler,
    private readonly privateOwnerUserId: string,
    private readonly proactiveRelationshipService?: ProactiveRelationshipService,
  ) {}

  acceptsOwner(ownerUserId: string): boolean {
    return ownerUserId === this.privateOwnerUserId;
  }

  async beginScheduledRun(input: BeginScheduledPresentLoopInput): Promise<BeginScheduledPresentLoopResult> {
    this.requireConfiguredOwner(input.ownerUserId);
    await this.proactiveRelationshipService?.reconcileNaturalEchoes(input.ownerUserId, input.catId);
    const started = await this.store.beginRun({
      ownerUserId: input.ownerUserId,
      catId: input.catId,
      threadId: input.threadId,
      taskId: input.taskId,
      scheduledAt: input.schedule.scheduledAt ? Date.parse(input.schedule.scheduledAt) : undefined,
      firedAt: Date.parse(input.schedule.firedAt),
      latenessMs: input.schedule.latenessMs,
      missedSlots: input.schedule.missedSlots,
    });
    const proactiveContext = this.proactiveRelationshipService
      ? await this.proactiveRelationshipService.loadWakeContext(input.ownerUserId, input.catId)
      : { pendingCues: [], ownedSeeds: [], recentEchoes: [] };
    return { ...started, proactiveContext };
  }

  renderWakePrompt(result: BeginScheduledPresentLoopResult, schedule: ScheduleRunTiming): string {
    return renderPresentLoopPrompt({
      runId: result.run.runId,
      schedule,
      continuity: result.continuity,
      proactive: result.proactiveContext,
    });
  }

  renderPersistedWakeTrigger(result: BeginPresentLoopRunResult, schedule: ScheduleRunTiming): string {
    return renderPersistedPresentLoopTrigger({ runId: result.run.runId, schedule });
  }

  async failWake(ownerUserId: string, runId: string, error: unknown): Promise<PresentLoopRunRecord> {
    const reason = error instanceof Error ? error.message : String(error);
    return this.store.failRun(ownerUserId, runId, reason);
  }

  async settle(principal: InvocationPrincipal, input: SettlePresentLoopValue): Promise<PresentLoopSettlementResult> {
    this.requireConfiguredOwner(principal.userId);
    const result = await this.store.settleRun(principal, input);
    let proactive = result.proactive;
    if (proactive.visit?.pendingMessageBody) {
      if (!this.proactiveRelationshipService) {
        throw new Error('F272 proactive message delivery is not configured');
      }
      const delivery = await this.proactiveRelationshipService.reconcileVisit(
        principal.userId,
        principal.catId,
        proactive.visit.visitId,
      );
      proactive = { ...proactive, visit: delivery.visit };
    } else if (proactive.visit?.status === 'reserved' && proactive.visit.projectedSurfaces.length === 0) {
      const released = await this.store.proactive.cancelUnseen(
        principal.userId,
        principal.catId,
        proactive.visit.visitId,
      );
      const intent = proactive.intent
        ? await this.store.proactive.getIntent(principal.userId, principal.catId, proactive.intent.intentId)
        : null;
      proactive = { ...proactive, intent, visit: released };
    }
    if (result.diary) await this.projector.reconcile(principal.userId);
    return { ...result, proactive };
  }

  async getLatestRun(ownerUserId: string, catId: string): Promise<PresentLoopRunRecord | null> {
    this.requireConfiguredOwner(ownerUserId);
    return this.store.getLatestRun(ownerUserId, catId);
  }

  private requireConfiguredOwner(ownerUserId: string): void {
    if (!this.acceptsOwner(ownerUserId)) {
      throw new AutoDreamStoreError(
        'OWNER_NOT_CONFIGURED',
        'owner is not configured for private diary persistence',
        403,
      );
    }
  }
}
