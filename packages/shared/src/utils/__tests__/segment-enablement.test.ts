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
const ALL_RUNTIME_ACTIONS: SegmentRuntimeOverrideAction[] = [
  'disable',
  'enable',
  'rollback',
  'activateVersion',
  'createVersion',
];

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
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m).sort()).toEqual(['createVersion', 'disable'].sort());
    expect(m.localOverlay.actions.edit.reasonCode).toBe('versioned-editor-required');
    expect(m.runtimeOverride.actions.disable.reasonCode).toBeNull();
    expect(runtimeReasonCode(m, 'enable')).toBe('already-enabled');
    expect(runtimeReasonCode(m, 'rollback')).toBe('no-override');
    expect(localReasonCode(m, 'restoreBackup')).toBe('versioned-editor-required');
    expect(runtimeReasonCode(m, 'activateVersion')).toBe('no-version-snapshot');
  });

  it('readonly blocks version creation and legacy local writes', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'readonly' });
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m)).toEqual(['disable']);
    expect(runtimeReasonCode(m, 'createVersion')).toBe('safety-tier-readonly');
    expect(localReasonCode(m, 'edit')).toBe('versioned-editor-required');
    expect(localReasonCode(m, 'restoreBackup')).toBe('versioned-editor-required');
    expect(runtimeReasonCode(m, 'activateVersion')).toBe('no-version-snapshot');
  });

  it('allowLocalOverride=false blocks edit/restore even when editable', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, allowLocalOverride: false });
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m).sort()).toEqual(['createVersion', 'disable'].sort());
    expect(localReasonCode(m, 'edit')).toBe('versioned-editor-required');
    expect(localReasonCode(m, 'restoreBackup')).toBe('versioned-editor-required');
  });

  it('disableable=false blocks disable while version creation stays available', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, disableable: false });
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m)).toEqual(['createVersion']);
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
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m).sort()).toEqual(['createVersion', 'enable', 'rollback'].sort());
    expect(runtimeReasonCode(m, 'disable')).toBe('already-disabled');
    expect(runtimeReasonCode(m, 'enable')).toBeNull();
  });

  it('content override enables rollback; version snapshot enables activateVersion without reviving local writes', () => {
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
    expect(allowedLocalActions(m)).toEqual([]);
    expect(allowedRuntimeActions(m).sort()).toEqual(['activateVersion', 'createVersion', 'disable', 'rollback'].sort());
  });

  it('legacy local writes stay blocked even when an overlay path exists', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'readonly',
      allowLocalOverride: true,
    });
    expect(allowedLocalActions(m)).toEqual([]);
    expect(localReasonCode(m, 'edit')).toBe('versioned-editor-required');
    expect(localReasonCode(m, 'restoreBackup')).toBe('versioned-editor-required');
  });

  it('legacy local writes report the versioned editor regardless of filesystem state', () => {
    const m = resolveSegmentEnablementMatrix({
      ...DEFAULT_INPUT,
      safetyTier: 'readonly',
      allowLocalOverride: false,
      localOverlay: { hasOverlay: false, hasBackup: true },
    });
    expect(localReasonCode(m, 'edit')).toBe('versioned-editor-required');
    expect(localReasonCode(m, 'restoreBackup')).toBe('versioned-editor-required');
  });

  it('limited-edit permits version creation but not legacy local writes', () => {
    const m = resolveSegmentEnablementMatrix({ ...DEFAULT_INPUT, safetyTier: 'limited-edit' });
    expect(m.localOverlay.actions.edit.allowed).toBe(false);
    expect(m.localOverlay.actions.edit.reasonCode).toBe('versioned-editor-required');
    expect(m.runtimeOverride.actions.activateVersion.allowed).toBe(false);
    expect(m.runtimeOverride.actions.createVersion.allowed).toBe(true);
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
