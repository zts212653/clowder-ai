import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CycleTriggerPolicy, HookManifest, ObjectiveLifecycle } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HookRegistry } from '../../../domains/prompt-hooks/HookRegistry.js';
import type { CycleVersionRef } from './CycleTriggerChecker.js';
import type { EvaluationCatalog } from './evaluation-catalog.js';

export interface ObjectiveVersionState {
  triggerPolicy: CycleTriggerPolicy;
  lifecycle: Exclude<ObjectiveLifecycle, 'retired'>;
}

interface ObjectiveVersionSnapshot {
  schemaVersion: 1;
  objective: { id: string; label: string; statement: string; lifecycle: ObjectiveLifecycle };
  evaluationModel: unknown;
  effectiveTriggerPolicy: CycleTriggerPolicy;
  effectiveLifecycle: Exclude<ObjectiveLifecycle, 'retired'>;
  units: Array<{
    unitId: string;
    manifest: HookManifest;
    enabled: boolean;
    activeContentVersion: number;
    contentHash: string;
    conditionOverride: unknown | null;
  }>;
}

const snapshotKey = (objectiveId: string, digest: string) => `harness-objective-version:${objectiveId}:${digest}`;

/** Content-addressed, immutable Objective versions; no hook-version record is reused as an Objective identity. */
export class ObjectiveVersionStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly catalog: EvaluationCatalog,
    private readonly getRegistry: () => HookRegistry | null,
  ) {}

  async resolve(objectiveId: string, state: ObjectiveVersionState): Promise<CycleVersionRef> {
    const snapshot = await this.capture(objectiveId, state);
    const serialized = stableStringify(snapshot);
    const digest = createHash('sha256').update(serialized).digest('hex');
    await this.redis.set(snapshotKey(objectiveId, digest), serialized, 'NX');
    return {
      version: `objective-${digest.slice(0, 16)}`,
      versionContentRef: snapshotKey(objectiveId, digest),
    };
  }

  private async capture(objectiveId: string, state: ObjectiveVersionState): Promise<ObjectiveVersionSnapshot> {
    const objective = this.catalog.registry.objectives.find((candidate) => candidate.id === objectiveId);
    const evaluationModel = this.catalog.registry.evaluationModels.find(
      (candidate) => candidate.id === objective?.evaluationModelId,
    );
    if (!objective || !evaluationModel) throw new Error(`cycle_evaluation_model_not_found:${objectiveId}`);
    const registry = this.getRegistry();
    if (!registry) throw new Error('hook_registry_not_initialized');
    const units = await Promise.all(
      this.catalog.manifest.units
        .filter((unit) => unit.objectives.some((attachment) => attachment.objectiveId === objectiveId))
        .map(async (unit) => {
          const hook = registry.getHook(unit.unitId);
          if (!hook) throw new Error(`harness_governance_hook_missing:${unit.unitId}`);
          const content = registry.getContentOverride(unit.unitId) ?? (await readFile(hook.templatePath, 'utf8'));
          return {
            unitId: unit.unitId,
            manifest: structuredClone(hook.manifest),
            enabled: registry.isEnabled(unit.unitId),
            activeContentVersion: registry.getActiveVersion(unit.unitId),
            contentHash: createHash('sha256').update(content).digest('hex'),
            conditionOverride: registry.getConditionOverride(unit.unitId) ?? null,
          };
        }),
    );
    units.sort((left, right) => left.unitId.localeCompare(right.unitId));
    return {
      schemaVersion: 1,
      objective: {
        id: objective.id,
        label: objective.label,
        statement: objective.statement,
        lifecycle: objective.lifecycle ?? 'active',
      },
      evaluationModel: structuredClone(evaluationModel),
      effectiveTriggerPolicy: structuredClone(state.triggerPolicy),
      effectiveLifecycle: state.lifecycle,
      units,
    };
  }
}

/**
 * Resolve the segment coordinate frozen into a CycleRecord. New records point
 * at an immutable Objective snapshot; pre-snapshot records embedded a compact
 * comma-separated `unitId@version` list directly in the ref.
 */
export async function segmentVersionFromContentRef(
  redis: RedisClient,
  versionContentRef: string,
  segmentId: string,
): Promise<number | null> {
  const legacy = legacySegmentVersion(versionContentRef, segmentId);
  if (legacy !== null) return legacy;
  if (!versionContentRef.startsWith('harness-objective-version:')) return null;

  const raw = await redis.get(versionContentRef);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.units)) return null;
    const unit = value.units.find(
      (candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.unitId === segmentId,
    );
    return unit && Number.isSafeInteger(unit.activeContentVersion) && Number(unit.activeContentVersion) > 0
      ? Number(unit.activeContentVersion)
      : null;
  } catch {
    return null;
  }
}

function legacySegmentVersion(versionContentRef: string, segmentId: string): number | null {
  const separator = versionContentRef.indexOf(':');
  if (separator < 0) return null;
  for (const token of versionContentRef.slice(separator + 1).split(',')) {
    const match = token.trim().match(/^(.+)@v?(\d+)$/);
    if (match?.[1] !== segmentId) continue;
    const version = Number(match[2]);
    return Number.isSafeInteger(version) && version > 0 ? version : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
