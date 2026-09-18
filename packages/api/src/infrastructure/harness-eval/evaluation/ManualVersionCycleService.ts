import type { CycleRecord, CycleWindow } from '@cat-cafe/shared';
import { cycleAcceptsOperatorVersionTransition } from '@cat-cafe/shared';
import type { EpochOrigin } from '../../../domains/prompt-hooks/HookOverrideContentStore.js';
import type { HookOverrideStore } from '../../../domains/prompt-hooks/HookOverrideStore.js';
import { priorSkipWindows } from './CycleTriggerChecker.js';
import { cycleTriggerPolicyFor } from './cycle-trigger-policy.js';
import type { ObjectiveEvaluationRuntime } from './ObjectiveEvaluationRuntime.js';

export type ManualVersionCycleErrorCode =
  | 'segment_not_found'
  | 'cycle_not_initialized'
  | 'evaluation_in_progress'
  | 'version_already_active'
  | 'active_version_changed'
  | 'base_version_not_found'
  | 'version_cycle_mismatch'
  | 'concurrent_transition'
  | 'compensation_failed';

export class ManualVersionCycleError extends Error {
  constructor(public readonly code: ManualVersionCycleErrorCode) {
    super(`manual_version_switch_${code}`);
    this.name = 'ManualVersionCycleError';
  }
}

interface ManualVersionCycleInput {
  ownerUserId: string;
  segmentId: string;
  targetVersion: number;
  actorId: string;
  reason: string;
  /**
   * Which content `targetVersion` names when a shipped manifest version and a
   * local epoch snapshot carry the same number. Omitted while the number is
   * unambiguous; required by the store once both origins claim it.
   */
  origin?: EpochOrigin;
}

interface ManualVersionCreateInput extends Omit<ManualVersionCycleInput, 'targetVersion'> {
  content: string;
  baseVersion: number;
  expectedActiveVersion: number;
}

interface ManualVersionCycleResult {
  objectiveId: string;
  fromVersion: number;
  toVersion: number;
  archivedCycleId: string;
  currentCycle: CycleRecord;
  baseVersion?: number;
}

/**
 * One operator content-version transition across the two F257 axes: mutate the
 * active segment content, archive the live tracing cycle, and start the
 * replacement Objective cycle. The cycle store owns the durable CAS; the
 * in-process Objective lock is shared with CycleTriggerChecker so an eval
 * request cannot race this action.
 */
export class ManualVersionCycleService {
  constructor(
    private readonly deps: {
      runtime: ObjectiveEvaluationRuntime;
      overrideStore: Pick<
        HookOverrideStore,
        'activateVersion' | 'getActiveVersion' | 'hasVersion' | 'setContentOverride'
      >;
      refreshOverrideSnapshot: () => Promise<void>;
      now?: () => number;
    },
  ) {}

  async switch(input: ManualVersionCycleInput): Promise<ManualVersionCycleResult> {
    const objectiveId = this.objectiveIdFor(input.segmentId);

    return this.deps.runtime.cycleChecker.withObjectiveLock(input.ownerUserId, objectiveId, () =>
      this.switchLocked(input, objectiveId),
    );
  }

  async create(input: ManualVersionCreateInput): Promise<ManualVersionCycleResult> {
    const objectiveId = this.objectiveIdFor(input.segmentId);
    return this.deps.runtime.cycleChecker.withObjectiveLock(input.ownerUserId, objectiveId, () =>
      this.createLocked(input, objectiveId),
    );
  }

  private async switchLocked(input: ManualVersionCycleInput, objectiveId: string): Promise<ManualVersionCycleResult> {
    const { current, sourceVersion, switchedAt, unfrozenSkips } = await this.prepare(input, objectiveId);
    if (sourceVersion === input.targetVersion) throw new ManualVersionCycleError('version_already_active');
    return this.mutateAndTransition(input, objectiveId, current, sourceVersion, switchedAt, unfrozenSkips, async () => {
      await this.deps.overrideStore.activateVersion(input.segmentId, input.targetVersion, input.actorId, {
        source: 'operator',
        reason: input.reason,
        ...(input.origin ? { origin: input.origin } : {}),
      });
      return input.targetVersion;
    });
  }

  private async createLocked(input: ManualVersionCreateInput, objectiveId: string): Promise<ManualVersionCycleResult> {
    const { current, sourceVersion, switchedAt, unfrozenSkips } = await this.prepare(input, objectiveId);
    if (sourceVersion !== input.expectedActiveVersion) {
      throw new ManualVersionCycleError('active_version_changed');
    }
    if (!(await this.deps.overrideStore.hasVersion(input.segmentId, input.baseVersion))) {
      throw new ManualVersionCycleError('base_version_not_found');
    }
    return this.mutateAndTransition(input, objectiveId, current, sourceVersion, switchedAt, unfrozenSkips, async () => {
      await this.deps.overrideStore.setContentOverride(input.segmentId, input.content, input.actorId, {
        source: 'operator',
        reason: input.reason,
        parentVersion: input.baseVersion,
      });
      return this.deps.overrideStore.getActiveVersion(input.segmentId);
    });
  }

  private async prepare(
    input: Pick<ManualVersionCycleInput, 'ownerUserId' | 'segmentId'>,
    objectiveId: string,
  ): Promise<{ current: CycleRecord; sourceVersion: number; switchedAt: number; unfrozenSkips: CycleWindow[] }> {
    const current = await this.deps.runtime.cycles.current(input.ownerUserId, objectiveId);
    if (!current) throw new ManualVersionCycleError('cycle_not_initialized');
    // idle: nothing in flight. stalled: both bounded nudges were spent with no
    // writeback, so the transition is the operator's cat-free exit; the frozen
    // evaluation window stays on the archived record as carry-over evidence.
    if (!cycleAcceptsOperatorVersionTransition(current.evalStatus)) {
      throw new ManualVersionCycleError('evaluation_in_progress');
    }
    const [sourceVersion, cycleSegmentVersion] = await Promise.all([
      this.deps.overrideStore.getActiveVersion(input.segmentId),
      this.deps.runtime.resolveSegmentVersion(current.versionContentRef, input.segmentId),
    ]);
    if (cycleSegmentVersion !== sourceVersion) throw new ManualVersionCycleError('version_cycle_mismatch');
    const observedAt = this.readNow();
    if (!Number.isFinite(observedAt) || observedAt < current.cycleStart) {
      throw new ManualVersionCycleError('concurrent_transition');
    }
    const switchedAt = Math.max(observedAt, current.cycleStart + 1);
    // An idle cycle has not frozen its windows yet, so the insufficient-evidence
    // look-back it would have made at its next request is resolved here — before
    // any content mutation, so a failed read never needs compensation.
    const unfrozenSkips =
      current.windows.length > 0
        ? []
        : priorSkipWindows(await this.deps.runtime.cycles.history(current.ownerUserId, current.objectiveId));
    return { current, sourceVersion, switchedAt, unfrozenSkips };
  }

  private async mutateAndTransition(
    input: Omit<ManualVersionCycleInput, 'targetVersion'> & { baseVersion?: number },
    objectiveId: string,
    current: CycleRecord,
    sourceVersion: number,
    switchedAt: number,
    unfrozenSkips: CycleWindow[],
    mutate: () => Promise<number>,
  ): Promise<ManualVersionCycleResult> {
    let mutationCompleted = false;
    try {
      const targetVersion = await mutate();
      mutationCompleted = true;
      await this.deps.refreshOverrideSnapshot();

      const nextVersion = await this.deps.runtime.resolveVersion(objectiveId, {
        triggerPolicy: cycleTriggerPolicyFor(this.deps.runtime.catalog, current),
        lifecycle: current.objectiveLifecycle ?? 'active',
      });
      const resolvedTarget = await this.deps.runtime.resolveSegmentVersion(
        nextVersion.versionContentRef,
        input.segmentId,
      );
      if (resolvedTarget !== targetVersion) throw new ManualVersionCycleError('version_cycle_mismatch');
      const completed = completedCycle(current, input, sourceVersion, targetVersion, switchedAt);
      const carryoverWindows = inheritedWindows(current, unfrozenSkips, input.segmentId, sourceVersion, switchedAt);
      const next = await this.deps.runtime.cycles.switchVersion(current, completed, nextVersion, carryoverWindows);
      if (!next) throw new ManualVersionCycleError('concurrent_transition');
      return {
        objectiveId,
        fromVersion: sourceVersion,
        toVersion: targetVersion,
        archivedCycleId: current.cycleId,
        currentCycle: next,
        ...(input.baseVersion == null ? {} : { baseVersion: input.baseVersion }),
      };
    } catch (error) {
      let shouldCompensate = mutationCompleted;
      if (!mutationCompleted) {
        try {
          shouldCompensate = (await this.deps.overrideStore.getActiveVersion(input.segmentId)) !== sourceVersion;
        } catch {
          throw new ManualVersionCycleError('compensation_failed');
        }
      }
      if (shouldCompensate) {
        try {
          await this.deps.overrideStore.activateVersion(input.segmentId, sourceVersion, input.actorId, {
            source: 'operator',
            reason: `补偿失败的版本切换：${input.reason}`,
          });
          await this.deps.refreshOverrideSnapshot();
        } catch {
          throw new ManualVersionCycleError('compensation_failed');
        }
      }
      throw error;
    }
  }

  private objectiveIdFor(segmentId: string): string {
    const unit = this.deps.runtime.catalog.manifest.units.find((candidate) => candidate.unitId === segmentId);
    const objectiveId = unit?.objectives[0]?.objectiveId;
    if (!unit || !objectiveId) throw new ManualVersionCycleError('segment_not_found');
    return objectiveId;
  }

  private readNow(): number {
    const now = (this.deps.now ?? Date.now)();
    if (!Number.isFinite(now) || now < 0) throw new ManualVersionCycleError('concurrent_transition');
    return now;
  }
}

function completedCycle(
  current: CycleRecord,
  input: Omit<ManualVersionCycleInput, 'targetVersion'> & { baseVersion?: number },
  sourceVersion: number,
  targetVersion: number,
  switchedAt: number,
): CycleRecord {
  return {
    ...current,
    cycleEnd: switchedAt,
    termination: {
      kind: 'manual-version-switch',
      segmentId: input.segmentId,
      fromVersion: sourceVersion,
      toVersion: targetVersion,
      ...(input.baseVersion == null ? {} : { baseVersion: input.baseVersion }),
      at: switchedAt,
      by: input.actorId,
      reason: input.reason,
    },
    closedAt: switchedAt,
  };
}

/**
 * Every window the terminated cycle had frozen — or would have frozen at its
 * next request — and never evaluated: prior insufficient-evidence windows,
 * earlier carry-over, and its own native window extended to the switch. They
 * all travel with provenance, because the assignment builder reads an
 * unannotated extra window as a native skip window and indexes its skip reason
 * by history position; after the switch that history starts with this
 * terminated record, so an unannotated window would be mis-attributed.
 */
function inheritedWindows(
  current: CycleRecord,
  unfrozenSkips: CycleWindow[],
  segmentId: string,
  sourceSegmentVersion: number,
  switchedAt: number,
): CycleWindow[] {
  const provenance: NonNullable<CycleWindow['provenance']> = {
    kind: 'manual-version-switch',
    sourceCycleId: current.cycleId,
    sourceVersion: current.version,
    sourceVersionContentRef: current.versionContentRef,
    sourceSegmentId: segmentId,
    sourceSegmentVersion,
  };
  const isNative = (window: CycleWindow) => !window.provenance && window.start === current.cycleStart;
  const unconsumed =
    current.windows.length > 0
      ? current.windows.filter((window) => !isNative(window))
      : [...unfrozenSkips, ...(current.carryoverWindows ?? [])];
  const inherited = unconsumed.map((window) => (window.provenance ? window : { ...window, provenance }));
  if (switchedAt > current.cycleStart) inherited.push({ start: current.cycleStart, end: switchedAt, provenance });
  return inherited;
}
