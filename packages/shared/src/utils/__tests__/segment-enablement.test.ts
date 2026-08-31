import { describe, expect, it } from 'vitest';
import {
  type ResolveSegmentEnablementMatrixInput,
  resolveSegmentEnablementMatrix,
  type SegmentLocalOverlayAction,
  type SegmentRuntimeOverrideAction,
} from '../segment-enablement.js';

const DEFAULT_INPUT: ResolveSegmentEnablementMatrixInput = {
  segmentId: 'S1',
  safetyTier: 'editable',
  allowLocalOverride: true,
  disableable: true,
  localOverlay: { hasOverlay: false, hasBackup: false },
  runtimeOverride: {
    enabled: true,
    hasOverride: false,
    hasContentOverride: false,
    hasVersionSnapshot: false,
    availableEpochVersions: [],
  },
};

const ALL_LOCAL_ACTIONS: SegmentLocalOverlayAction[] = ['edit', 'restoreBackup', 'reset'];
const ALL_RUNTIME_ACTIONS: SegmentRuntimeOverrideAction[] = ['disable', 'enable', 'rollback', 'activateVersion'];

function allowedLocalActions(matrix: ReturnType<typeof resolveSegmentEnablementMatrix>): SegmentLocalOverlayAction[] {
  return ALL_LOCAL_ACTIONS.filter((a) => matrix.localOverlay.actions[a].allowed);
}

function allowedRuntimeActions(
  matrix: ReturnType<typeof resolveSegmentEnablementMatrix>,
): SegmentRuntimeOverrideAction[] {
  return ALL_RUNTIME_ACTIONS.filter((a) => matrix.runtimeOverride.actions[a].allowed);
}

function localReasonCode(matrix: ReturnType<typeof resolveSegmentEnablementMatrix>, action: SegmentLocalOverlayAction) {
  return matrix.localOverlay.actions[action].reasonCode;
}

function runtimeReasonCode(
  matrix: ReturnType<typeof resolveSegmentEnablementMatrix>,
  action: SegmentRuntimeOverrideAction,
) {
  return matrix.runtimeOverride.actions[action].reasonCode;
}

describe('resolveSegmentEnablementMatrix', () => {
  it('editable + allowLocalOverride + disableable + enabled baseline', () => {
    const m = resolveSegmentEnablementMatrix(DEFAULT_INPUT);
    expect(allowedLocalActions(m).sort()).toEqual(['edit'].sort());
    expect(allowedRuntimeActions(m).sort()).toEqual(['disable'].sort());
    expect(m.localOverlay.actions.edit.reasonCode).toBeNull();
    expect(m.runtimeOverride.actions.disable.reasonCode).toBeNull();
    expect(runtimeReasonCode(m, 'enable')).toBe('already-enabled');
    expect(runtimeReasonCode(m, 'rollback')).toBe('no-override');
    expect(localReasonCode(m, 'restoreBackup')).toBe('no-backup');
    expect(runtimeReasonCode(m, 'activateVersion')).toBe('no-version-snapshot');
  });

  it('readonly does not block an owner-authored local overlay', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'readonly' });
    expect(allowedLocalActions(m)).toEqual(['edit']);
    expect(allowedRuntimeActions(m)).toEqual(['disable']);
    expect(localReasonCode(m, 'edit')).toBeNull();
    expect(localReasonCode(m, 'restoreBackup')).toBe('no-backup');
    expect(runtimeReasonCode(m, 'activateVersion')).toBe('no-version-snapshot');
  });

  it('allowLocalOverride=false blocks edit/restore even when editable', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, allowLocalOverride: false });
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m)).toEqual(['disable']);
    expect(localReasonCode(m, 'edit')).toBe('no-local-overlay-path');
    expect(localReasonCode(m, 'restoreBackup')).toBe('no-backup');
  });

  it('disableable=false blocks disable but leaves edit intact', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, disableable: false });
    expect(allowedLocalActions(m)).toEqual(['edit']);
    expect(allowedRuntimeActions(m)).toEqual([]);
    expect(runtimeReasonCode(m, 'disable')).toBe('not-disableable');
  });

  it('disabled override enables enable action and blocks disable', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      runtimeOverride: {
        enabled: false,
        hasOverride: true,
        hasContentOverride: false,
        hasVersionSnapshot: false,
        availableEpochVersions: [],
      },
    });
    expect(allowedLocalActions(m).sort()).toEqual(['edit'].sort());
    expect(allowedRuntimeActions(m).sort()).toEqual(['enable', 'rollback'].sort());
    expect(runtimeReasonCode(m, 'disable')).toBe('already-disabled');
    expect(runtimeReasonCode(m, 'enable')).toBeNull();
  });

  it('content override enables rollback; version snapshot enables activateVersion', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      localOverlay: { hasOverlay: true, hasBackup: true },
      runtimeOverride: {
        enabled: true,
        hasOverride: true,
        hasContentOverride: true,
        hasVersionSnapshot: true,
        availableEpochVersions: [2, 3],
      },
    });
    expect(allowedLocalActions(m).sort()).toEqual(['edit', 'reset', 'restoreBackup'].sort());
    expect(allowedRuntimeActions(m).sort()).toEqual(['activateVersion', 'disable', 'rollback'].sort());
  });

  it('readonly and allowLocalOverride=true keeps local editing available', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'readonly',
      allowLocalOverride: true,
    });
    expect(allowedLocalActions(m)).toEqual(['edit']);
    expect(localReasonCode(m, 'edit')).toBeNull();
    // restoreBackup is blocked by the absence of a backup before safetyTier is reached.
    expect(localReasonCode(m, 'restoreBackup')).toBe('no-backup');
  });

  it('readonly + no overlay path is blocked only by the missing writable path', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'readonly',
      allowLocalOverride: false,
      localOverlay: { hasOverlay: false, hasBackup: true },
    });
    expect(localReasonCode(m, 'edit')).toBe('no-local-overlay-path');
    expect(localReasonCode(m, 'restoreBackup')).toBe('no-local-overlay-path');
  });

  it('limited-edit does not block matrix edit (source gate enforced server-side)', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'limited-edit' });
    expect(m.localOverlay.actions.edit.allowed).toBe(true);
    expect(m.runtimeOverride.actions.activateVersion.allowed).toBe(false);
    expect(runtimeReasonCode(m, 'activateVersion')).toBe('no-version-snapshot');
  });

  it('disabled without override cannot be enabled', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      runtimeOverride: {
        enabled: false,
        hasOverride: false,
        hasContentOverride: false,
        hasVersionSnapshot: false,
        availableEpochVersions: [],
      },
    });
    expect(runtimeReasonCode(m, 'enable')).toBe('no-disable-override');
  });

  it('exposes dimension fields on matrix', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'limited-edit',
      disableable: false,
    });
    expect(m.segmentId).toBe('S1');
    expect(m.safetyTier).toBe('limited-edit');
    expect(m.allowLocalOverride).toBe(true);
    expect(m.disableable).toBe(false);
    expect(m.runtimeOverride.enabled).toBe(true);
  });

  it('activateVersion allowed after rollback because snapshots remain', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      runtimeOverride: {
        enabled: true,
        hasOverride: false,
        hasContentOverride: false,
        hasVersionSnapshot: true,
        availableEpochVersions: [2],
      },
    });
    expect(allowedRuntimeActions(m)).toContain('activateVersion');
    expect(runtimeReasonCode(m, 'activateVersion')).toBeNull();
  });
});
