import { expect, it } from 'vitest';
import { createArtifactWorkPresentationState, isWorkspaceFullWindowSurface } from '../artifact-work-presentation';
import { createEvolutionProgramSurface, createFileSurface, createWorkspaceModeSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-initial-state';
import { projectWorkspaceWorkHost } from '../workspace-work-host-projection';

it.each([
  'cover.png',
  'cover.jpg',
  'cover.webp',
  'cover.ico',
  'cover.avif',
  'clip.mp4',
  'clip.mkv',
  'clip.avi',
  'clip.m4v',
  'clip.ogv',
  'notes.md',
  'notes.markdown',
  'notes.mdx',
  'notes.txt',
  'notes.docx',
])('v2 %s uses the existing artwork split and fullscreen controller', (path) => {
  const file = createFileSurface({ worktreeId: 'wt-a', path });
  expect(isWorkspaceFullWindowSurface(file, 'v2')).toBe(true);
  const projected = projectWorkspaceWorkHost(
    {
      threadId: 'thread-a',
      viewMode: 'single',
      isDesktop: true,
      statusPanelOpen: true,
      rightPanelMode: 'workspace',
      shellPresentation: 'v2',
    },
    createInitialWorkbenchState([file]),
    createArtifactWorkPresentationState(),
  );
  expect(projected.hostEligible).toBe(true);
  expect(projected.splitPreferenceActive).toBe(true);
  expect(isWorkspaceFullWindowSurface(file, 'classic')).toBe(false);
});

it.each([
  'package.json',
  'tsconfig.json',
  'Cargo.toml',
  'config.yaml',
  'data.csv',
  'build.log',
  '.env',
  '.gitignore',
  'Makefile',
  'Dockerfile',
  'LICENSE',
  'notes.conf',
  'notes.pdf',
  'notes.pptx',
  'notes.xlsx',
  'source.ts',
  'source.py',
])('v2 %s stays in the ordinary file surface instead of implicitly entering work presentation', (path) => {
  const file = createFileSurface({ worktreeId: 'wt-a', path });
  expect(isWorkspaceFullWindowSurface(file, 'v2')).toBe(false);
  const projected = projectWorkspaceWorkHost(
    {
      threadId: 'thread-a',
      viewMode: 'single',
      isDesktop: true,
      statusPanelOpen: true,
      rightPanelMode: 'workspace',
      shellPresentation: 'v2',
    },
    createInitialWorkbenchState([file]),
    createArtifactWorkPresentationState(),
  );
  expect(projected.hostEligible).toBe(false);
  expect(projected.splitPreferenceActive).toBe(false);
});

it('explicit work mode suppresses the sidebar beside Chat and keeps it suppressed after full-window', () => {
  const file = createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' });
  const input = {
    threadId: 'thread-a',
    viewMode: 'single' as const,
    isDesktop: true,
    statusPanelOpen: true,
    rightPanelMode: 'workspace' as const,
    shellPresentation: 'v2' as const,
  };
  const initial = createArtifactWorkPresentationState();
  const presentation = {
    ...initial,
    session: {
      generation: 1,
      threadId: 'thread-a',
      surfaceId: file.id,
      mode: 'split' as const,
      workMode: true as const,
      returnHandle: {
        host: { owner: 'chat', key: 'thread-a' },
        workbench: { owner: 'f307', key: file.id },
        client: file.ownerStateRef,
        chatReadingRef: null,
      },
    },
  };
  const layout = createInitialWorkbenchState([file]);
  expect(projectWorkspaceWorkHost(input, layout, presentation)).toMatchObject({
    workModeActive: true,
    suppressCafeSidebar: true,
    fullWindowActive: false,
  });
  expect(projectWorkspaceWorkHost({ ...input, threadId: 'foreign' }, layout, presentation)).toMatchObject({
    workModeActive: false,
    suppressCafeSidebar: false,
  });
  expect(projectWorkspaceWorkHost(input, layout, initial).suppressCafeSidebar).toBe(false);
  expect(projectWorkspaceWorkHost({ ...input, workModeRequested: true }, layout, initial).suppressCafeSidebar).toBe(
    true,
  );
  expect(
    projectWorkspaceWorkHost({ ...input, threadId: null, workModeRequested: true }, layout, initial)
      .suppressCafeSidebar,
  ).toBe(false);
  expect(
    projectWorkspaceWorkHost({ ...input, isDesktop: false, workModeRequested: true }, layout, initial)
      .suppressCafeSidebar,
  ).toBe(false);
});

it('code files and malformed file identities keep the ordinary viewer geometry', () => {
  const code = createFileSurface({ worktreeId: 'wt-a', path: 'source.ts' });
  expect(isWorkspaceFullWindowSurface(code, 'v2')).toBe(false);
  const invalid = {
    ...createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' }),
    ownerStateRef: { owner: 'other-owner', key: 'wt-a' },
  };
  expect(isWorkspaceFullWindowSurface(invalid, 'v2')).toBe(false);
});

it('a visible same-thread narrow artwork keeps the one composer without opening a desktop session', () => {
  const file = createFileSurface({ worktreeId: 'wt-a', path: 'cover.png' });
  const input = {
    threadId: 'thread-a',
    currentThreadId: 'thread-a',
    mediaComposerSurfaceId: file.id,
    viewMode: 'single' as const,
    isDesktop: false,
    statusPanelOpen: true,
    rightPanelMode: 'workspace' as const,
    shellPresentation: 'v2' as const,
  };
  const project = (patch = {}) =>
    projectWorkspaceWorkHost(
      { ...input, ...patch },
      createInitialWorkbenchState([file]),
      createArtifactWorkPresentationState(),
    );
  expect(project().narrowWorkComposerActive).toBe(true);
  expect(project().hostEligible).toBe(false);
  expect(project().fullWindowActive).toBe(false);
  for (const patch of [
    { currentThreadId: 'foreign' },
    { statusPanelOpen: false },
    { viewMode: 'split' },
    { shellPresentation: 'classic' },
    { mediaComposerSurfaceId: null },
    { rightPanelMode: 'status' },
  ])
    expect(project(patch).narrowWorkComposerActive).toBe(false);
});

it('projects the explicit Schedule wide session beside visible Chat and suppresses only its sidebar projection', () => {
  const schedule = createWorkspaceModeSurface('product-schedule', 'thread-a');
  const layout = createInitialWorkbenchState([schedule]);
  const input: Parameters<typeof projectWorkspaceWorkHost>[0] = {
    threadId: 'thread-a',
    viewMode: 'single',
    isDesktop: true,
    statusPanelOpen: true,
    rightPanelMode: 'workspace',
    shellPresentation: 'v2',
  };
  const attention = {
    surfaceId: schedule.id,
    presentation: { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 30 },
  };
  const project = (patch: Partial<typeof input> = {}) =>
    projectWorkspaceWorkHost({ ...input, ...patch }, layout, createArtifactWorkPresentationState(), attention);
  expect(project().workspaceWideActive).toBe(true);
  expect(project().suppressCafeSidebar).toBe(true);
  expect(project().fullWindowActive).toBe(false);
  for (const patch of [
    { threadId: 'thread-b' },
    { isDesktop: false },
    { statusPanelOpen: false },
    { viewMode: 'split' as const },
    { rightPanelMode: 'status' as const },
  ]) {
    expect(project(patch).workspaceWideActive).toBe(false);
    expect(project(patch).suppressCafeSidebar).toBe(false);
  }
  expect(projectWorkspaceWorkHost(input, layout, createArtifactWorkPresentationState()).workspaceWideActive).toBe(
    false,
  );
});

it('projects an evolution Program reading beside the exact visible Chat instead of covering it', () => {
  const program = createEvolutionProgramSurface(`evolution-program:${'a'.repeat(32)}`);
  const layout = createInitialWorkbenchState([program]);
  const input: Parameters<typeof projectWorkspaceWorkHost>[0] = {
    threadId: 'thread-a',
    viewMode: 'single',
    isDesktop: true,
    statusPanelOpen: true,
    rightPanelMode: 'workspace',
    shellPresentation: 'v2',
  };
  const attention = {
    surfaceId: program.id,
    presentation: { kind: 'chat-workspace' as const, threadId: 'thread-a', chatBasis: 34 },
  };

  expect(projectWorkspaceWorkHost(input, layout, createArtifactWorkPresentationState(), attention)).toMatchObject({
    workspaceWideActive: true,
    suppressCafeSidebar: true,
    fullWindowActive: false,
  });
});

it.each([
  'cover.png',
  'clip.mp4',
])('explicit narrow %s work mode keeps the gallery header and return while desktop sessions stay ineligible', (path) => {
  const file = createFileSurface({
    worktreeId: 'wt-a',
    path,
    navigationOrigin: { kind: 'chat-file-link', threadId: 'thread-a', messageId: 'original' },
  });
  const input = {
    threadId: 'thread-a',
    currentThreadId: 'thread-a',
    mediaComposerSurfaceId: file.id,
    viewMode: 'single' as const,
    isDesktop: false,
    statusPanelOpen: true,
    rightPanelMode: 'workspace' as const,
    shellPresentation: 'v2' as const,
    workModeRequested: true,
  };
  const layout = createInitialWorkbenchState([file]);
  const project = (patch: Partial<Parameters<typeof projectWorkspaceWorkHost>[0]> = {}) =>
    projectWorkspaceWorkHost({ ...input, ...patch }, layout, createArtifactWorkPresentationState());
  expect(project()).toMatchObject({
    workModeActive: true,
    narrowWorkComposerActive: true,
    hostEligible: false,
    fullWindowActive: false,
    splitPreferenceActive: false,
  });
  // Loading has not registered a composer yet, but consuming the open request must
  // not discard the already explicit artwork session or its return/gallery header.
  expect(project({ mediaComposerSurfaceId: null })).toMatchObject({
    workModeActive: true,
    narrowWorkComposerActive: false,
    hostEligible: false,
    fullWindowActive: false,
  });
  for (const patch of [
    { currentThreadId: 'foreign' },
    { statusPanelOpen: false },
    { viewMode: 'split' as const },
    { shellPresentation: 'classic' as const },
    { rightPanelMode: 'status' as const },
    { workModeRequested: false },
  ])
    expect(project(patch).workModeActive).toBe(false);
});
