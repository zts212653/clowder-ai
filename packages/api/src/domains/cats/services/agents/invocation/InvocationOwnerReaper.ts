import { performance } from 'node:perf_hooks';
import type { CatId, TurnExecutionRecord } from '@cat-cafe/shared';
import { resolveCliTimeoutMs } from '../../../../../utils/cli-timeout.js';
import type { IInvocationRecordStore, InvocationRecord } from '../../stores/ports/InvocationRecordStore.js';
import type { CodexAppServerLifecycleSnapshot } from '../providers/CodexAppServerLifecycle.js';
import {
  classifyIndependentInvocationOwner,
  type IndependentOwnerVerdict,
  PROVIDER_TERMINAL_STAGES,
} from './InvocationOwnerEvidence.js';
import { InvocationOwnerHealthReporter } from './InvocationOwnerHealthReporter.js';
import {
  collectInvocationOwnerCandidates,
  type InvocationOwnerTrackerLike,
  type OwnerCandidate,
  type StaleProcessingOwnerLease,
} from './InvocationOwnerLeaseCandidates.js';
import { DEFAULT_INVOCATION_SLOT_TTL_MS } from './InvocationTracker.js';
import { type ExitedChildRecovery, retireExitedChildExecutions } from './RetireExitedChildExecutions.js';
import type { ReconcileZombieResult, ZombieRecord } from './reconcileZombies.js';

interface InvocationOwnerReaperLog {
  info(obj: unknown, message?: string): void;
  warn(obj: unknown, message?: string): void;
}

export interface InvocationOwnerReaperOptions extends ExitedChildRecovery {
  invocationTracker: InvocationOwnerTrackerLike;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'> &
    Partial<Pick<IInvocationRecordStore, 'observeOwnerRecovery' | 'getOwnerRecoveryFacts'>>;
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
  reapStalePrestartReservations?: (now?: number) => number | Promise<number>;
  ownerLeaseTtlMs?: number;
  healthSlaMs?: number;
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

interface OwnerProbe {
  record: InvocationRecord | null;
  children: TurnExecutionRecord[];
  providerSnapshots: CodexAppServerLifecycleSnapshot[];
  verdict: IndependentOwnerVerdict;
}

export class InvocationOwnerReaper {
  private readonly now: () => number;
  private readonly ownerLeaseTtlMs: number;
  private readonly healthSlaMs: number;
  private readonly health: InvocationOwnerHealthReporter;

  constructor(private readonly options: InvocationOwnerReaperOptions) {
    this.now = options.now ?? (() => Date.now());
    this.health = new InvocationOwnerHealthReporter(options.invocationRecordStore, options.log);
    this.ownerLeaseTtlMs = options.ownerLeaseTtlMs ?? DEFAULT_INVOCATION_SLOT_TTL_MS;
    // Match the actual work owner's lease SLA, or the member's configured maximum busy-output allowance.
    // CLI_TIMEOUT_MS=0 disables its timeout; it does not authorize inventing a terminal result here.
    this.healthSlaMs = options.healthSlaMs ?? Math.max(this.ownerLeaseTtlMs, 2 * resolveCliTimeoutMs(undefined));
  }

  async runOnce(): Promise<InvocationOwnerReaperRunResult> {
    const started = performance.now();
    const now = this.now();
    this.health.startRound();
    const result = emptyResult();
    result.prestartReaped = (await this.options.reapStalePrestartReservations?.(now)) ?? 0;
    const candidates = await this.collectCandidates(now, result);
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      try {
        await this.processCandidate(candidate, now, result);
      } catch (err) {
        result.errors++;
        result.deferredUnknown++;
        await this.warnUnknown({
          executionId: candidate.executionId,
          reason: 'owner_recovery_failed',
          err: formatError(err),
        });
      }
    }

    this.options.log.info(
      {
        event: 'invocation_owner_reaper_sweep',
        loopId: 'invocation-owner',
        elapsedMs: performance.now() - started,
        ...result,
      },
      '[F118] invocation owner reaper sweep completed',
    );
    this.health.endRound();
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
        this.health.warnLocalUnknown({
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
    const recovery = await this.options.invocationRecordStore.getOwnerRecoveryFacts?.(candidate.executionId);
    if (recovery?.disposition && recovery.recordStatus === 'running') {
      result.deferredUnknown++;
      return;
    }
    if (candidate.scopeCollision) {
      result.deferredUnknown += 1;
      await this.warnUnknown({ executionId: candidate.executionId, reason: 'execution_scope_collision' });
      return;
    }

    let probe = await this.probeCandidate(candidate, now);
    if (!probe) {
      result.deferredUnknown += 1;
      result.errors += 1;
      return;
    }
    if (probe.verdict === 'unknown') {
      result.deferredUnknown += 1;
      await this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'owner_probe_scope_unknown',
      });
      return;
    }
    if (probe.verdict === 'active') {
      if (
        probe.children.some((child) => child.status === 'running') &&
        !probe.providerSnapshots.some((snapshot) => !PROVIDER_TERMINAL_STAGES.has(snapshot.stage))
      ) {
        try {
          if (await retireExitedChildExecutions(candidate, this.options, now)) {
            probe = await this.probeCandidate(candidate, now);
            if (!probe) {
              result.deferredUnknown += 1;
              return;
            }
            if (probe.verdict === 'unknown') {
              result.deferredUnknown += 1;
              return;
            }
            if (probe.verdict === 'terminal') {
              await this.reconcileCandidate(candidate, probe, result);
              return;
            }
          }
        } catch (err) {
          result.deferredUnknown += 1;
          await this.warnUnknown({
            executionId: candidate.executionId,
            reason: 'exited_child_recovery_failed',
            err: formatError(err),
          });
          return;
        }
      }
      await this.recordActiveCandidate(candidate, probe, now, result);
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
        verdict: classifyIndependentInvocationOwner(candidate, record, children, providerSnapshots),
      };
    } catch (err) {
      await this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'owner_probe_failed',
        err: formatError(err),
      });
      return null;
    }
  }

  private async recordActiveCandidate(
    candidate: OwnerCandidate,
    probe: OwnerProbe,
    now: number,
    result: InvocationOwnerReaperRunResult,
  ): Promise<void> {
    result.keptActive += 1;
    const stages = probe.providerSnapshots.map((snapshot) => snapshot.stage).sort();
    const lastActivity = probe.providerSnapshots.length
      ? Math.max(...probe.providerSnapshots.map((snapshot) => snapshot.lastActivityAt))
      : null;
    const signature = JSON.stringify({
      verdict: 'active',
      stages,
      children: probe.children.map((child) => child.status).sort(),
    });
    const observation = await this.health.observe(candidate.executionId, {
      signature,
      silence: lastActivity !== null && now - lastActivity >= this.healthSlaMs,
      failed: false,
    });
    const fields = {
      executionId: candidate.executionId,
      threadId: candidate.threadId,
      leaseAgeMs: now - candidate.startedAt,
      providerStages: stages,
      lastProviderActivityAt: lastActivity,
    };
    if (observation.changed)
      this.options.log.info(
        { event: 'invocation_owner_reaper_kept_active', ...fields },
        '[F118] stale lease retained because an independent owner is still live',
      );
    if (observation.silenceNew)
      this.options.log.warn(
        { event: 'invocation_owner_provider_silence', ...fields, healthSlaMs: this.healthSlaMs },
        '[F118] provider activity exceeded the work SLA; live ownership retained for inspection',
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
        await this.warnUnknown({
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
      await this.warnUnknown({
        executionId: candidate.executionId,
        threadId: candidate.threadId,
        reason: 'terminal_reconciliation_failed',
        err: formatError(err),
      });
    }
  }

  private async warnUnknown(fields: Record<string, unknown>): Promise<void> {
    const signature = JSON.stringify({ verdict: 'unknown', reason: fields.reason, err: fields.err });
    const receipt = await this.health.observe(String(fields.executionId), {
      signature,
      silence: false,
      failed: String(fields.reason).endsWith('failed'),
    });
    if (receipt.changed)
      this.options.log.warn(
        { event: 'invocation_owner_reaper_deferred_unknown', ...fields, recoveryParked: receipt.parked },
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
