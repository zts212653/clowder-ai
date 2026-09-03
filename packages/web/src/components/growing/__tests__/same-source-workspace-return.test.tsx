import { describe, expect, it } from 'vitest';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState, reduceWorkbench } from '@/components/workbench/workbench-model';
import { resolveEntrustedWorkActionTarget } from '@/hooks/useWorkspaceNavigate';

const capabilities: WorkspaceSurfaceDescriptor['capabilities'] = {
  split: true,
  sidecar: true,
  pin: true,
  closePolicy: 'detach-host',
  restorePolicy: 'descriptor',
};

const needsMe: WorkspaceSurfaceDescriptor = {
  id: 'workspace:mode:needs-me',
  type: 'workspace',
  renderer: 'workspace-destination',
  title: 'Needs Me',
  context: '只放需要你判断或修复的事项',
  objectRef: { kind: 'workspace-destination', id: 'mode:needs-me' },
  ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:needs-me' },
  resultTargetRef: {
    owner: 'f310-needs-me-navigation',
    key: encodeURIComponent(JSON.stringify(['global', 'task:work:ppt|4|f306.runtime_interaction|interaction:ppt|11'])),
  },
  capabilities,
};

const productSchedule: WorkspaceSurfaceDescriptor = {
  id: 'workspace:mode:product-schedule',
  type: 'workspace',
  renderer: 'workspace-destination',
  title: 'Schedule',
  context: '托付工作的截止与审阅时间',
  objectRef: { kind: 'workspace-destination', id: 'mode:product-schedule' },
  ownerStateRef: { owner: 'f284-workspace-launcher', key: 'mode:product-schedule' },
  resultTargetRef: {
    owner: 'f310-product-schedule-navigation',
    key: encodeURIComponent(JSON.stringify(['global', 'task:work:ppt|4'])),
  },
  capabilities,
};

const artifact: WorkspaceSurfaceDescriptor = {
  id: 'artifact:thread-ppt:artifact-id',
  type: 'artifact',
  renderer: 'artifact-view',
  title: 'Tomorrow presentation',
  context: 'Thread 产物 · file',
  objectRef: { kind: 'artifact', id: 'artifact-id' },
  ownerStateRef: { owner: 'f232-thread-artifacts', key: 'thread-ppt' },
  resultTargetRef: { owner: 'thread-message', key: 'thread-ppt:message-artifact' },
  capabilities,
};

const user = { kind: 'user', reason: 'workspace-home-selection' } as const;

describe('F310 same-source Workspace return', () => {
  it('types producer action refs into their existing canonical surfaces', () => {
    expect(resolveEntrustedWorkActionTarget('/api/proposals/proposal%2Fone')).toEqual({
      kind: 'approval',
      producerId: 'F128',
      proposalId: 'proposal/one',
    });
    expect(resolveEntrustedWorkActionTarget('/api/meeting-intakes/intake%2Fone/confirm')).toEqual({
      kind: 'approval',
      producerId: 'F292',
      proposalId: 'intake/one',
    });
    expect(resolveEntrustedWorkActionTarget('/api/meeting-intakes/intake-1/retry')).toEqual({
      kind: 'approval',
      producerId: 'F292',
      proposalId: 'intake-1',
    });
    expect(resolveEntrustedWorkActionTarget('/api/tasks/task-1')).toBeNull();
  });

  it('keeps the exact Needs Me item as desktop sidecar and promotes it on Artifact close', () => {
    let state = createInitialWorkbenchState([needsMe]);
    state = reduceWorkbench(state, {
      type: 'open-artifact-with-return',
      artifact,
      returnSurface: needsMe,
      presentation: 'desktop',
      entitlement: user,
    });

    expect(state.surfaces).toEqual([artifact]);
    expect(state.activeSurfaceId).toBe(artifact.id);
    expect(state.sidecar).toEqual(needsMe);

    state = reduceWorkbench(state, {
      type: 'close-artifact-to-return',
      artifactSurfaceId: artifact.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(state.surfaces).toEqual([needsMe]);
    expect(state.activeSurfaceId).toBe(needsMe.id);
    expect(state.sidecar).toBeNull();
    expect(state.surfaces[0]?.resultTargetRef).toEqual(needsMe.resultTargetRef);
  });

  it('opens Artifact full-screen at 390px while the exact Needs Me return coordinate stays in the stack', () => {
    let state = createInitialWorkbenchState([needsMe]);
    state = reduceWorkbench(state, {
      type: 'open-artifact-with-return',
      artifact,
      returnSurface: needsMe,
      presentation: 'mobile',
      entitlement: user,
    });

    expect(state.surfaces).toEqual([needsMe, artifact]);
    expect(state.activeSurfaceId).toBe(artifact.id);
    expect(state.sidecar).toBeNull();

    state = reduceWorkbench(state, {
      type: 'close-artifact-to-return',
      artifactSurfaceId: artifact.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(state.surfaces).toEqual([needsMe]);
    expect(state.activeSurfaceId).toBe(needsMe.id);
    expect(state.surfaces[0]?.resultTargetRef).toEqual(needsMe.resultTargetRef);
  });

  it('preserves the exact product Schedule row through the same Artifact return action', () => {
    let state = createInitialWorkbenchState([productSchedule]);
    state = reduceWorkbench(state, {
      type: 'open-artifact-with-return',
      artifact,
      returnSurface: productSchedule,
      presentation: 'desktop',
      entitlement: user,
    });

    expect(state.activeSurfaceId).toBe(artifact.id);
    expect(state.sidecar).toEqual(productSchedule);

    state = reduceWorkbench(state, {
      type: 'close-artifact-to-return',
      artifactSurfaceId: artifact.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(state.surfaces).toEqual([productSchedule]);
    expect(state.activeSurfaceId).toBe(productSchedule.id);
    expect(state.surfaces[0]?.resultTargetRef).toEqual(productSchedule.resultTargetRef);
  });
});
