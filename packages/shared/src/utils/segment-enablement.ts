/**
 * F257 Console 判据⑥ — Segment enablement matrix.
 *
 * Centralizes the `safetyTier × allowLocalOverride × disableable × overrideState`
 * decision table so API, read-model, and Console UI share one contract.
 *
 * The matrix is split into two independent storage planes so no action name is
 * overloaded:
 *   - localOverlay  → filesystem `.local` overlay files (editor / backup / reset)
 *   - runtimeOverride → Redis-backed HookOverrideStore
 *     (disable/enable/rollback/activateVersion/createVersion)
 */

import type { HookManifest, SafetyTier } from '../types/prompt-hook.js';

export type SegmentLocalOverlayAction = 'edit' | 'restoreBackup' | 'reset';
export type SegmentRuntimeOverrideAction = 'disable' | 'enable' | 'rollback' | 'activateVersion' | 'createVersion';

export interface SegmentActionPermission {
  allowed: boolean;
  /** Human-readable reason when blocked; null when allowed. */
  reason: string | null;
  /** Machine-readable reason code when blocked; null when allowed. */
  reasonCode: string | null;
}

export interface SegmentLocalOverlayState {
  /** A `.local` overlay file exists for this segment. */
  hasOverlay: boolean;
  /** A `.local.bak` rollback snapshot exists. */
  hasBackup: boolean;
  actions: Record<SegmentLocalOverlayAction, SegmentActionPermission>;
}

export interface SegmentRuntimeOverrideState {
  /** Effective enabled state (override false → manifest baseline true). */
  enabled: boolean;
  /** Any runtime override record exists in the store. */
  hasOverride: boolean;
  /** A content override is currently active. */
  hasContentOverride: boolean;
  /** At least one historical version snapshot is retained. */
  hasVersionSnapshot: boolean;
  /** Epoch versions available for activation via HookOverrideStore snapshots. */
  availableEpochVersions: number[];
  actions: Record<SegmentRuntimeOverrideAction, SegmentActionPermission>;
}

export interface SegmentEnablementMatrix {
  segmentId: string;
  safetyTier: SafetyTier;
  allowLocalOverride: boolean;
  disableable: boolean;
  localOverlay: SegmentLocalOverlayState;
  runtimeOverride: SegmentRuntimeOverrideState;
}

export interface SegmentLocalOverlayInput {
  hasOverlay: boolean;
  hasBackup: boolean;
}

export interface SegmentRuntimeOverrideInput {
  enabled: boolean;
  hasOverride: boolean;
  hasContentOverride: boolean;
  hasVersionSnapshot: boolean;
  availableEpochVersions: number[];
}

export interface ResolveSegmentEnablementMatrixInput {
  segmentId: string;
  safetyTier: SafetyTier;
  allowLocalOverride: boolean;
  disableable: boolean;
  localOverlay: SegmentLocalOverlayInput;
  runtimeOverride: SegmentRuntimeOverrideInput;
}

/** Compute the unified enablement matrix for a segment. */
export function resolveSegmentEnablementMatrix(input: ResolveSegmentEnablementMatrixInput): SegmentEnablementMatrix {
  const { segmentId, safetyTier, allowLocalOverride, disableable, localOverlay, runtimeOverride } = input;

  const legacyLocalWriteBlocked: SegmentActionPermission = {
    allowed: false,
    reason: '本地覆盖写入已迁移到版本生命周期，请产生并应用新版本',
    reasonCode: 'versioned-editor-required',
  };
  const localActions: Record<SegmentLocalOverlayAction, SegmentActionPermission> = {
    edit: legacyLocalWriteBlocked,
    restoreBackup: legacyLocalWriteBlocked,
    reset: legacyLocalWriteBlocked,
  };

  const runtimeActions: Record<SegmentRuntimeOverrideAction, SegmentActionPermission> = {
    disable: {
      allowed: disableable && runtimeOverride.enabled,
      reason: disableable ? (runtimeOverride.enabled ? null : '当前段已禁用') : '当前段 disableable=false，不可禁用',
      reasonCode: disableable ? (runtimeOverride.enabled ? null : 'already-disabled') : 'not-disableable',
    },
    enable: {
      allowed: !runtimeOverride.enabled && runtimeOverride.hasOverride,
      reason:
        !runtimeOverride.enabled && runtimeOverride.hasOverride
          ? null
          : runtimeOverride.enabled
            ? '当前段已启用'
            : '当前段无禁用覆盖可启用',
      reasonCode:
        !runtimeOverride.enabled && runtimeOverride.hasOverride
          ? null
          : runtimeOverride.enabled
            ? 'already-enabled'
            : 'no-disable-override',
    },
    rollback: {
      allowed: runtimeOverride.hasOverride,
      reason: runtimeOverride.hasOverride ? null : '当前段无覆盖可回滚',
      reasonCode: runtimeOverride.hasOverride ? null : 'no-override',
    },
    activateVersion: {
      allowed: runtimeOverride.hasVersionSnapshot && safetyTier !== 'readonly',
      reason: runtimeOverride.hasVersionSnapshot
        ? safetyTier === 'readonly'
          ? '当前段 safetyTier=readonly，禁止激活版本'
          : null
        : '当前段无保留版本可激活',
      reasonCode:
        runtimeOverride.hasVersionSnapshot && safetyTier !== 'readonly'
          ? null
          : !runtimeOverride.hasVersionSnapshot
            ? 'no-version-snapshot'
            : 'safety-tier-readonly',
    },
    createVersion: {
      allowed: safetyTier !== 'readonly',
      reason: safetyTier === 'readonly' ? '当前段 safetyTier=readonly，禁止产生新版本' : null,
      reasonCode: safetyTier === 'readonly' ? 'safety-tier-readonly' : null,
    },
  };

  return {
    segmentId,
    safetyTier,
    allowLocalOverride,
    disableable,
    localOverlay: {
      hasOverlay: localOverlay.hasOverlay,
      hasBackup: localOverlay.hasBackup,
      actions: localActions,
    },
    runtimeOverride: {
      enabled: runtimeOverride.enabled,
      hasOverride: runtimeOverride.hasOverride,
      hasContentOverride: runtimeOverride.hasContentOverride,
      hasVersionSnapshot: runtimeOverride.hasVersionSnapshot,
      availableEpochVersions: runtimeOverride.availableEpochVersions,
      actions: runtimeActions,
    },
  };
}

/** Convenience: build matrix from a hook manifest + runtime state. */
export function resolveSegmentEnablementMatrixFromManifest(
  manifest: Pick<HookManifest, 'id' | 'safetyTier' | 'disableable'>,
  allowLocalOverride: boolean,
  localOverlay: SegmentLocalOverlayInput,
  runtimeOverride: SegmentRuntimeOverrideInput,
): SegmentEnablementMatrix {
  return resolveSegmentEnablementMatrix({
    segmentId: manifest.id,
    safetyTier: manifest.safetyTier,
    allowLocalOverride,
    disableable: manifest.disableable,
    localOverlay,
    runtimeOverride,
  });
}
