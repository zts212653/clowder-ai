import { describe, expect, it } from 'vitest';
import { createFileSurface } from '@/components/workbench/real-surface-adapters';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import {
  createInitialWorkbenchState,
  reduceWorkbench,
  restoreWorkbenchState,
} from '@/components/workbench/workbench-model';
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
  it.each([
    [needsMe, 'desktop'],
    [needsMe, 'mobile'],
    [productSchedule, 'desktop'],
    [productSchedule, 'mobile'],
  ] as const)('opens the resolved FILE and retains its %s return on %s', (returnSurface, presentation) => {
    const file = createFileSurface({ worktreeId: 'original-root', path: 'docs/后续建设.md' });
    let state = reduceWorkbench(createInitialWorkbenchState([returnSurface]), {
      type: 'open-artifact-with-return',
      artifact: file,
      returnSurface,
      presentation,
      entitlement: user,
    });
    expect(state.activeSurfaceId).toBe(file.id);
    expect(state.surfaces.find((s) => s.id === file.id)?.returnTargetRef).toEqual(returnSurface.resultTargetRef);
    if (presentation === 'desktop') expect(state.sidecar).toEqual(returnSurface);
    else expect(state.surfaces).toContainEqual(returnSurface);
    state = reduceWorkbench(state, {
      type: 'close-artifact-to-return',
      artifactSurfaceId: file.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    expect(state.surfaces).toEqual([returnSurface]);
    expect(state.activeSurfaceId).toBe(returnSurface.id);
    expect(state.sidecar).toBeNull();
  });

  it('does not infer a Task return for a normal unbound file from an unrelated sidecar', () => {
    const file = createFileSurface({ worktreeId: 'original-root', path: 'docs/plain.md' });
    const state = { ...createInitialWorkbenchState([file]), sidecar: needsMe };
    expect(
      reduceWorkbench(state, {
        type: 'close-artifact-to-return',
        artifactSurfaceId: file.id,
        entitlement: user,
      }),
    ).toBe(state);
  });

  it('keeps the existing entitlement, valid file owner and live source requirements', () => {
    const file = createFileSurface({ worktreeId: 'original-root', path: 'docs/prepared.md' });
    const state = createInitialWorkbenchState([productSchedule]);
    const input = {
      type: 'open-artifact-with-return',
      artifact: file,
      returnSurface: productSchedule,
      presentation: 'desktop',
      entitlement: user,
    } as const;
    expect(reduceWorkbench(state, { ...input, entitlement: { kind: 'background', reason: 'owner-background' } })).toBe(
      state,
    );
    expect(
      reduceWorkbench(state, { ...input, artifact: { ...file, ownerStateRef: { owner: 'foreign', key: 'root' } } }),
    ).toBe(state);
    const withoutSource = createInitialWorkbenchState([file]);
    expect(reduceWorkbench(withoutSource, input)).toBe(withoutSource);
  });

  it('types producer action refs into their existing canonical surfaces', () => {
    expect(resolveEntrustedWorkActionTarget('/api/proposals/proposal%2Fone')).toEqual({
      kind: 'approval',
      producerId: 'F128',
      proposalId: 'proposal/one',
    });
    expect(resolveEntrustedWorkActionTarget('/api/meeting-intakes/intake%2Fone/confirm')).toBeNull();
    expect(resolveEntrustedWorkActionTarget('/api/meeting-intakes/intake-1/retry')).toBeNull();
    expect(resolveEntrustedWorkActionTarget('/api/tasks/task-1')).toBeNull();
    expect(
      resolveEntrustedWorkActionTarget(
        '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2',
      ),
    ).toEqual({
      kind: 'collective-work',
      connectionId: 'con_aaaaaaaa',
      workId: 'work_aaaaaaaa',
      workRevision: 4,
      channelId: 'general',
      resultEventId: 'evt_result0000',
      resultRevision: 2,
      actionRef:
        '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2',
    });
    expect(
      resolveEntrustedWorkActionTarget(
        '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000',
      ),
    ).toMatchObject({ resultRevision: 1 });
    expect(
      resolveEntrustedWorkActionTarget(
        '/collective?connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&resultEventId=evt_result0000&resultRevision=2&taskId=private',
      ),
    ).toBeNull();
    expect(
      resolveEntrustedWorkActionTarget(
        '/collective?target=accountability&connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&roadmapId=roadmap_aaaaaaaa&accountabilityRequestId=accountability_aaaaaaaa',
      ),
    ).toEqual({
      kind: 'collective-accountability',
      connectionId: 'con_aaaaaaaa',
      workId: 'work_aaaaaaaa',
      workRevision: 4,
      channelId: 'general',
      roadmapId: 'roadmap_aaaaaaaa',
      accountabilityRequestId: 'accountability_aaaaaaaa',
      actionRef:
        '/collective?target=accountability&connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&roadmapId=roadmap_aaaaaaaa&accountabilityRequestId=accountability_aaaaaaaa',
    });
    expect(
      resolveEntrustedWorkActionTarget(
        '/collective?target=accountability&connectionId=con_aaaaaaaa&workId=work_aaaaaaaa&workRevision=4&channelId=general&roadmapId=roadmap_aaaaaaaa&accountabilityRequestId=accountability_aaaaaaaa&resultEventId=evt_result0000',
      ),
    ).toBeNull();
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

    expect(state.surfaces).toEqual([{ ...artifact, returnTargetRef: needsMe.resultTargetRef }]);
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

    expect(state.surfaces).toEqual([needsMe, { ...artifact, returnTargetRef: needsMe.resultTargetRef }]);
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

  it.each([
    'desktop',
    'mobile',
  ] as const)('the ordinary tab close also restores the exact return on %s', (presentation) => {
    let state = reduceWorkbench(createInitialWorkbenchState([productSchedule]), {
      type: 'open-artifact-with-return',
      artifact,
      returnSurface: productSchedule,
      presentation,
      entitlement: user,
    });
    state = reduceWorkbench(state, {
      type: 'close-surface',
      surfaceId: artifact.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    expect(state.activeSurfaceId).toBe(productSchedule.id);
    expect(state.surfaces).toEqual([productSchedule]);
    expect(state.sidecar).toBeNull();
  });

  it('persists the Artifact return edge and never borrows a different current item after reload', () => {
    let state = reduceWorkbench(createInitialWorkbenchState([productSchedule]), {
      type: 'open-artifact-with-return',
      artifact,
      returnSurface: productSchedule,
      presentation: 'desktop',
      entitlement: user,
    });
    state = {
      ...state,
      sidecar: {
        ...productSchedule,
        resultTargetRef: {
          owner: 'f310-product-schedule-navigation',
          key: encodeURIComponent(JSON.stringify(['global', 'task:work:other|9'])),
        },
      },
    };
    state = restoreWorkbenchState(JSON.parse(JSON.stringify(state)));
    state = reduceWorkbench(state, { type: 'close-surface', surfaceId: artifact.id, entitlement: user });
    expect(state.surfaces[0]?.resultTargetRef).toEqual(productSchedule.resultTargetRef);
    expect(state.activeSurfaceId).toBe(productSchedule.id);
    expect(state.sidecar).toBeNull();
  });

  it('closing an unrelated Artifact does not promote a different work item from the sidecar', () => {
    const state = { ...createInitialWorkbenchState([artifact]), sidecar: productSchedule };
    const closed = reduceWorkbench(state, { type: 'close-surface', surfaceId: artifact.id, entitlement: user });
    expect(closed.surfaces).toEqual([]);
    expect(closed.sidecar).toEqual(productSchedule);
  });
});
