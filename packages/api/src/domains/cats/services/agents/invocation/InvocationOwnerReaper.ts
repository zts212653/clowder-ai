import type { CatId, TurnExecutionRecord } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { CodexAppServerLifecycleSnapshot } from '../providers/CodexAppServerLifecycle.js';
import type { ZombieRecord } from './getThreadLiveInvocations.js';
import {
  collectInvocationOwnerCandidates,
  type InvocationOwnerTrackerLike,
  type OwnerCandidate,
  type StaleProcessingOwnerLease,
} from './InvocationOwnerLeaseCandidates.js';
import { DEFAULT_INVOCATION_SLOT_TTL_MS } from './InvocationTracker.js';
import type { ReconcileZombieResult } from './reconcileZombies.js';

interface InvocationOwnerReaperLog {
  info(obj: unknown, message?: string): void;
  warn(obj: unknown, message?: string): void;
}

export interface InvocationOwnerReaperOptions {
  invocationTracker: InvocationOwnerTrackerLike;
  invocationRecordStore: {
    get(id: string): InvocationRecord | null | Promise<InvocationRecord | null>;
  };
  turnExecutionStore: {
    listByParent(parentInvocationId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]>;
  };
  getProviderLifecycle(
    threadId: string,
    catId: string,
    executionId: string,
    now?: number,
  ): CodexAppServerLifecycleSnapshot | undefined;
  reconcileZombie(zombie: ZombieRecord): Promise<ReconcileZombieResult>;
  releaseExactOwner(threadId: string, targetCats: readonly string[], executionId: string): void | Promise<void>;
  /** Durable running records cover process-local owner projections that were already lost. */
  listRunningRecords?: () => InvocationRecord[] | Promise<InvocationRecord[]>;
  /** Queue reservations whose tracker owner was installed but later disappeared. */
  listStaleProcessingLeases?: (now?: number) => StaleProcessingOwnerLease[];
  /** Pre-provider reservations are safe to recover without probing provider lifecycle. */
  reapStalePrestartReservations?: (now?: number) => number;
  ownerLeaseTtlMs?: number;
  now?: () => number;
  log: InvocationOwnerReaperLog;
}

export interface InvocationOwnerReaperRunResult {
  scanned: number;
  keptActive: number;
  reaped: number;
  releasedTerminal: number;
  replacements: number;
  deferredUnknown: number;
  prestartReaped: number;
  errors: number;
}

type IndependentOwnerVerdict = 'active' | 'terminal' | 'absent' | 'unknown';

interface OwnerProbe {
  record: InvocationRecord | null;
  children: TurnExecutionRecord[];
  providerSnapshots: CodexAppServerLifecycleSnapshot[];
  verdict: IndependentOwnerVerdict;
}

const PROVIDER_TERMINAL_STAGES = new Set<CodexAppServerLifecycleSnapshot['stage']>([
  'completed',
  'interrupted',
  'failed',
  'closed',
]);

export class InvocationOwnerReaper {
  private readonly now: () => number;
  private readonly ownerLeaseTtlMs: number;

  constructor(private readonly options: InvocationOwnerReaperOptions) {
    this.now = options.now ?? (() => Date.now());
    this.ownerLeaseTtlMs = options.ownerLeaseTtlMs ?? DEFAULT_INVOCATION_SLOT_TTL_MS;
  }

  async runOnce(): Promise<InvocationOwnerReaperRunResult> {
    const now = this.now();
    const result = emptyResult();
    result.prestartReaped = this.options.reapStalePrestartReservations?.(now) ?? 0;
    const candidates = await this.collectCandidates(now, result);
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      await this.processCandidate(candidate, now, result);
    }

    if (result.scanned > 0 || result.prestartReaped > 0) {
      this.options.log.info(
        { event: 'invocation_owner_reaper_sweep', ...result },
        '[F118] invocation owner reaper sweep completed',
      );
    }
    return result;
  }

  private async collectCandidates(now: number, result: InvocationOwnerReaperRunResult): Promise<OwnerCandidate[]> {
    return collectInvocationOwnerCandidates({
      invocationTracker: this.options.invocationTracker,
      listStaleProcessingLeases: this.options.listStaleProcessingLeases,
      listRunningRecords: this.options.listRunningRecords,
      ownerLeaseTtlMs: this.ownerLeaseTtlMs,
      now,
      onUnboundTrackerLease: (lease) => {
        result.deferredUnknown += 1;
        this.warnUnknown({
          threadId: lease.threadId,
          catId: lease.catId,
          reason: 'stale_tracker_lease_missing_execution_id',
          ageMs: lease.ageMs,
        });
      },
      onRecordScanError: (err) => {
        result.errors += 1;
        this.options.log.warn(
          { event: 'invocation_owner_reaper_scan_failed', err: formatError(err) },
          '[F118] durable running-record scan failed; process-local candidates remain eligible',
        );
      },
    });
  }

  private async processCandidate(
    candidate: OwnerCandidate,
    now: number,
    result: InvocationOwnerReaperRunResult,
  ): Promise<void> {
    if (candidate.scopeCollision) {
      result.deferredUnknown += 1;
      this.warnUnknown({ executionId: candidate.executionId, reason: 'execution_scope_collision' });
      return;
    }

    const probe = await this.probeCandidate(candidate, now);
    if (!probe) {
      result.deferredUnknown += 1;
      result.errors += 1;
      return;
    }
    if (probe.verdict === 'unknown') {
      result.deferredUnknown += 1;
      this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'owner_probe_scope_unknown',
      });
      return;
    }
    if (probe.verdict === 'active') {
      this.recordActiveCandidate(candidate, probe, now, result);
      return;
    }

    await this.reconcileCandidate(candidate, probe, result);
  }

  private async probeCandidate(candidate: OwnerCandidate, now: number): Promise<OwnerProbe | null> {
    try {
      const [record, children] = await Promise.all([
        this.options.invocationRecordStore.get(candidate.executionId),
        this.options.turnExecutionStore.listByParent(candidate.executionId),
      ]);
      for (const catId of record?.targetCats ?? []) candidate.targetCats.add(catId);
      const providerSnapshots = [...candidate.targetCats]
        .map((catId) => this.options.getProviderLifecycle(candidate.threadId, catId, candidate.executionId, now))
        .filter((snapshot): snapshot is CodexAppServerLifecycleSnapshot => snapshot !== undefined);
      return {
        record,
        children,
        providerSnapshots,
        verdict: this.classifyIndependentOwner(candidate, record, children, providerSnapshots),
      };
    } catch (err) {
      this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'owner_probe_failed',
        err: formatError(err),
      });
      return null;
    }
  }

  private recordActiveCandidate(
    candidate: OwnerCandidate,
    probe: OwnerProbe,
    now: number,
    result: InvocationOwnerReaperRunResult,
  ): void {
    result.keptActive += 1;
    this.options.log.info(
      {
        event: 'invocation_owner_reaper_kept_active',
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        leaseAgeMs: now - candidate.startedAt,
        childRunning: probe.children.some((child) => child.status === 'running'),
        providerStages: probe.providerSnapshots.map((snapshot) => snapshot.stage),
        lastProviderActivityAt:
          probe.providerSnapshots.length > 0
            ? Math.max(...probe.providerSnapshots.map((snapshot) => snapshot.lastActivityAt))
            : null,
      },
      '[F118] stale lease retained because an independent owner is still live',
    );
  }

  private async reconcileCandidate(
    candidate: OwnerCandidate,
    probe: OwnerProbe,
    result: InvocationOwnerReaperRunResult,
  ): Promise<void> {
    const replacements = candidate.trackerSlots.filter(
      ({ threadId, catId }) =>
        this.options.invocationTracker.classifyExecutionId(threadId, catId, candidate.executionId) === 'replacement',
    );
    result.replacements += replacements.length;

    const targetCats = [...new Set([...(probe.record?.targetCats ?? []), ...candidate.targetCats])];
    const zombie: ZombieRecord = {
      invocationId: candidate.executionId,
      catId: (targetCats[0] as CatId | undefined) ?? null,
      recordStatus: 'running',
      recordUpdatedAt: probe.record?.updatedAt ?? candidate.startedAt,
      reason: 'owner_lease_stale_provider_absent',
    };
    try {
      const reconciliation = await this.options.reconcileZombie(zombie);
      if (reconciliation.errors > 0 || (reconciliation.reconciled === 0 && reconciliation.alreadyTerminal === 0)) {
        result.deferredUnknown += 1;
        result.errors += reconciliation.errors || 1;
        this.warnUnknown({
          executionId: candidate.executionId,
          threadId: candidate.threadId,
          reason: 'terminal_reconciliation_incomplete',
          reconciliation,
        });
        return;
      }
      await this.options.releaseExactOwner(candidate.threadId, targetCats, candidate.executionId);
      if (probe.verdict === 'terminal') result.releasedTerminal += 1;
      else result.reaped += 1;
    } catch (err) {
      result.deferredUnknown += 1;
      result.errors += 1;
      this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'terminal_reconciliation_failed',
        err: formatError(err),
      });
    }
  }

  private classifyIndependentOwner(
    candidate: OwnerCandidate,
    record: InvocationRecord | null,
    children: TurnExecutionRecord[],
    providerSnapshots: CodexAppServerLifecycleSnapshot[],
  ): IndependentOwnerVerdict {
    if (
      record &&
      (record.id !== candidate.executionId ||
        record.threadId !== candidate.threadId ||
        record.userId !== candidate.userId)
    ) {
      return 'unknown';
    }
    if (
      children.some(
        (child) =>
          child.parentInvocationId !== candidate.executionId ||
          child.threadId !== candidate.threadId ||
          child.userId !== candidate.userId,
      )
    ) {
      return 'unknown';
    }

    const childRunning = children.some((child) => child.status === 'running');
    const providerActive = providerSnapshots.some((snapshot) => !PROVIDER_TERMINAL_STAGES.has(snapshot.stage));
    if (childRunning || providerActive) return 'active';

    if (record && (record.status === 'succeeded' || record.status === 'failed' || record.status === 'canceled')) {
      return 'terminal';
    }
    if (record?.status === 'queued') return 'unknown';
    if (children.length > 0 || providerSnapshots.length > 0) return 'terminal';
    if (record === null || record.status === 'running') return 'absent';
    return 'unknown';
  }

  private warnUnknown(fields: Record<string, unknown>): void {
    this.options.log.warn(
      { event: 'invocation_owner_reaper_deferred_unknown', ...fields },
      '[F118] stale owner retained because independent liveness is unknown',
    );
  }
}

function emptyResult(): InvocationOwnerReaperRunResult {
  return {
    scanned: 0,
    keptActive: 0,
    reaped: 0,
    releasedTerminal: 0,
    replacements: 0,
    deferredUnknown: 0,
    prestartReaped: 0,
    errors: 0,
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
