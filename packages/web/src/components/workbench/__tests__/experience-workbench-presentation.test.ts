import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import {
  createAgentRunSurface,
  createArtifactSurface,
  createBrowserSurface,
  createEvolutionProgramSurface,
  createFileSurface,
  createProductScheduleReturnSurface,
  createTerminalSurface,
  createWorkspaceModeSurface,
} from '../real-surface-adapters';

const PROGRAM_SURFACE = createEvolutionProgramSurface(`evolution-program:${'b'.repeat(32)}`);
const FILE_SURFACE = createFileSurface({ worktreeId: 'worktree-main', path: 'README.md' });
const BROWSER_SURFACE = createBrowserSurface({ ownerKey: 'preview-main', port: 4173, path: '/docs' });
const TERMINAL_SURFACE = createTerminalSurface({ worktreeId: 'worktree-main' });
const AGENT_RUN_SURFACE = createAgentRunSurface({
  invocationId: 'invocation-f307',
  threadId: 'thread-f307',
  title: 'F307 verification',
});
const ARTIFACT_SURFACE: WorkspaceSurfaceDescriptor = {
  ...FILE_SURFACE,
  id: 'artifact:thread-review:result',
  type: 'artifact',
  renderer: 'artifact-view',
  title: 'Review result',
  objectRef: { kind: 'artifact', id: 'result' },
};

function enterProgramAttention(layout: WorkbenchLayoutState): void {
  useF307ExperienceWorkbenchStore.setState({
    layout,
    hydrated: true,
    mainAreaAttentionSurfaceId: null,
  });
  const store = useF307ExperienceWorkbenchStore.getState();
  store.dispatch({
    type: 'activate-surface',
    surfaceId: PROGRAM_SURFACE.id,
    entitlement: { kind: 'user', reason: 'surface-tab' },
  });
  store.enterMainAreaAttention(PROGRAM_SURFACE.id);
}

describe('F307 temporary main-area attention contract', () => {
  beforeEach(() => {
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([FILE_SURFACE, PROGRAM_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
  });

  it('admits every active mounted Workspace tab without a domain-specific opt-in', () => {
    for (const surface of [FILE_SURFACE, BROWSER_SURFACE, TERMINAL_SURFACE, AGENT_RUN_SURFACE, PROGRAM_SURFACE]) {
      useF307ExperienceWorkbenchStore.setState({
        layout: createInitialWorkbenchState([surface]),
        hydrated: true,
        mainAreaAttentionSurfaceId: null,
      });

      useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(surface.id);

      expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(surface.id);
      useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
    }

    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([FILE_SURFACE, PROGRAM_SURFACE]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
    });
    useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(PROGRAM_SURFACE.id);
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns automatically when focus leaves or the attention surface is detached', () => {
    const store = useF307ExperienceWorkbenchStore.getState();
    store.dispatch({
      type: 'activate-surface',
      surfaceId: PROGRAM_SURFACE.id,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    });
    store.enterMainAreaAttention(PROGRAM_SURFACE.id);

    store.dispatch({
      type: 'activate-surface',
      surfaceId: FILE_SURFACE.id,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();

    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'activate-surface',
      surfaceId: PROGRAM_SURFACE.id,
      entitlement: { kind: 'user', reason: 'surface-tab' },
    });
    useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(PROGRAM_SURFACE.id);
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-surface',
      surfaceId: PROGRAM_SURFACE.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns when another surface is detached from the working set', () => {
    enterProgramAttention(createInitialWorkbenchState([FILE_SURFACE, PROGRAM_SURFACE]));

    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-surface',
      surfaceId: FILE_SURFACE.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });

    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns when bulk close detaches other surfaces while preserving the Program', () => {
    enterProgramAttention(createInitialWorkbenchState([FILE_SURFACE, PROGRAM_SURFACE]));

    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-other-surfaces',
      preserveSurfaceId: PROGRAM_SURFACE.id,
      entitlement: { kind: 'user', reason: 'bulk-close' },
    });

    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });

  it('returns for artifact and sidecar detach equivalents', () => {
    enterProgramAttention(createInitialWorkbenchState([ARTIFACT_SURFACE, PROGRAM_SURFACE]));
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-artifact-to-return',
      artifactSurfaceId: ARTIFACT_SURFACE.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();

    const sidecarLayout = createInitialWorkbenchState([PROGRAM_SURFACE]);
    sidecarLayout.sidecar = FILE_SURFACE;
    enterProgramAttention(sidecarLayout);
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'close-sidecar',
      entitlement: { kind: 'user', reason: 'sidecar-action' },
    });
    expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  });
});

it('keeps the original wide geometry session across the exact Schedule publication and Back without persisting it', () => {
  const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
  const selected = createProductScheduleReturnSurface(schedule, 'task:work:calendar-task');
  if (!selected) throw new Error('The original return item must be admitted');
  const artifact = createArtifactSurface({
    threadId: 'thread-a',
    artifact: {
      type: 'file',
      name: 'result.md',
      url: '/uploads/result.md',
      catId: 'codex61-sol',
      sourceMessageId: 'publication-calendar',
      createdAt: 7,
    },
  });
  const presentation = { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 30 };
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([schedule]), hydrated: true });
  const store = useF307ExperienceWorkbenchStore.getState();
  store.enterMainAreaAttention(schedule.id, presentation);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual(presentation);
  store.setMainAreaAttentionChatBasis(42);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
    ...presentation,
    chatBasis: 42,
  });
  store.setMainAreaAttentionChatBasis(Number.NaN);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
    ...presentation,
    chatBasis: 42,
  });
  store.setMainAreaAttentionChatBasis(100);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
    ...presentation,
    chatBasis: 80,
  });
  store.setMainAreaAttentionChatBasis(-1);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
    ...presentation,
    chatBasis: 20,
  });
  store.setMainAreaAttentionChatBasis(30);
  store.dispatch({
    type: 'open-artifact-with-return',
    artifact,
    returnSurface: selected,
    presentation: 'desktop',
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(artifact.id);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual(presentation);
  store.dispatch({
    type: 'close-artifact-to-return',
    artifactSurfaceId: artifact.id,
    entitlement: { kind: 'user', reason: 'return-origin' },
  });
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(schedule.id);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual(presentation);
  store.exitMainAreaAttention();
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({ kind: 'overlay' });
  expect(JSON.stringify(useF307ExperienceWorkbenchStore.getState().layout)).not.toContain('chat-workspace');
});

it('admits a wide Schedule only in its captured host and clears it on a different foreground target', () => {
  const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
  const presentation = { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 30 };
  const store = useF307ExperienceWorkbenchStore.getState();
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([schedule, FILE_SURFACE]) });
  store.enterMainAreaAttention(schedule.id, { ...presentation, threadId: 'thread-b' });
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  store.enterMainAreaAttention(FILE_SURFACE.id, presentation);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  store.enterMainAreaAttention(schedule.id, presentation);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(schedule.id);
  store.dispatch({
    type: 'activate-surface',
    surfaceId: 'missing-surface',
    entitlement: { kind: 'user', reason: 'surface-tab' },
  });
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBe(schedule.id);
  store.dispatch({
    type: 'activate-surface',
    surfaceId: FILE_SURFACE.id,
    entitlement: { kind: 'user', reason: 'surface-tab' },
  });
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({ kind: 'overlay' });
  store.setMainAreaAttentionChatBasis(50);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({ kind: 'overlay' });
});

it('admits an evolution Program into the same Chat-preserving wide host', () => {
  const presentation = { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 34 };
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([PROGRAM_SURFACE]) });

  useF307ExperienceWorkbenchStore.getState().enterMainAreaAttention(PROGRAM_SURFACE.id, presentation);

  expect(useF307ExperienceWorkbenchStore.getState()).toMatchObject({
    mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id,
    mainAreaAttentionPresentation: presentation,
  });
  useF307ExperienceWorkbenchStore.getState().enterMainAreaFullWindow(PROGRAM_SURFACE.id);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionPresentation).toEqual({
    ...presentation,
    mode: 'full-window',
  });
  useF307ExperienceWorkbenchStore.getState().returnFromMainAreaFullWindow();
  expect(useF307ExperienceWorkbenchStore.getState()).toMatchObject({
    mainAreaAttentionSurfaceId: PROGRAM_SURFACE.id,
    mainAreaAttentionPresentation: presentation,
  });
});
