import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createBrowserSurface, createFileSurface, resolveFileTarget } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';
import { bindWorkspaceForeground, lockCurrentWorkspace } from '../workspace-presentation-lock';

const fileA = createFileSurface({ worktreeId: 'shared-worktree', path: 'A.md', scrollToLine: 7 });
const fileB = createFileSurface({ worktreeId: 'shared-worktree', path: 'B.md', scrollToLine: 42 });
const browser = createBrowserSurface({ ownerKey: 'browser-b', port: 5324, path: '/browser-owner-probe' });
let unbind: () => void;

beforeEach(() => {
  useChatStore.setState({
    currentThreadId: 'thread-a',
    presentationLock: null,
    workspaceForegroundSurfaceId: fileA.id,
    workspaceWorktreeId: 'shared-worktree',
    workspaceOpenFilePath: 'A.md',
    workspaceOpenFileLine: 7,
    workspaceOpenTabs: ['A.md'],
    workspaceSurface: 'files',
    workspaceScrollTop: 123,
    threadStates: {
      'thread-b': {
        ...DEFAULT_THREAD_STATE,
        workspaceWorktreeId: 'shared-worktree',
        workspaceOpenFilePath: 'B.md',
        workspaceOpenFileLine: 42,
        workspaceOpenTabs: ['B.md'],
        workspaceSurface: 'files',
        workspaceForegroundSurfaceId: fileB.id,
      },
    },
  });
  useF307ExperienceWorkbenchStore.setState({
    hydrated: true,
    layout: { ...createInitialWorkbenchState(), surfaces: [fileA, browser], activeSurfaceId: fileA.id },
    focusSurfaceId: null,
    mainAreaAttentionSurfaceId: null,
  });
  unbind = bindWorkspaceForeground();
});

afterEach(() => {
  unbind();
  useChatStore.setState({ presentationLock: null });
});

it('restores B’s exact file and line even though the two conversations share one worktree surface id', () => {
  expect(fileA.id).toBe(fileB.id);
  lockCurrentWorkspace();
  useF307ExperienceWorkbenchStore.getState().enterFocusMode(fileA.id);
  useChatStore.getState().setCurrentThread('thread-b');
  const locked = useF307ExperienceWorkbenchStore.getState();
  expect(resolveFileTarget(locked.layout.surfaces[0])?.path).toBe('A.md');
  expect(locked.focusSurfaceId).toBe(fileA.id);
  useChatStore.getState().disablePresentationLock();
  const restored = useF307ExperienceWorkbenchStore.getState();
  expect(resolveFileTarget(restored.layout.surfaces[0])).toMatchObject({ path: 'B.md', scrollToLine: 42 });
  expect(restored.focusSurfaceId).toBeNull();
});

it('records the file owner coordinate in the original per-thread Workspace fields on a real foreground change', () => {
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'open-surface',
    surface: fileB,
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
  const state = useChatStore.getState();
  expect(state.workspaceForegroundSurfaceId).toBe(fileB.id);
  expect(state.workspaceOpenFilePath).toBe('B.md');
  expect(state.workspaceOpenFileLine).toBe(42);
  expect(state.threadStates['thread-a'].workspaceOpenFilePath).toBe('B.md');
});

it('restores the current conversation’s exact file when that shared owner was previously closed', () => {
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'close-surface',
    surfaceId: fileA.id,
    entitlement: { kind: 'user', reason: 'close-button' },
  });
  useChatStore.getState().setCurrentThread('thread-b');
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  expect(layout.activeSurfaceId).toBe(fileB.id);
  const restored = layout.surfaces.find((surface) => surface.id === fileB.id);
  if (!restored) throw new Error('the original file owner must be restored');
  expect(resolveFileTarget(restored)).toMatchObject({
    path: 'B.md',
    scrollToLine: 42,
  });
  expect(layout.recentlyClosed).toHaveLength(0);
});

it('restores the current conversation’s exact preview path when its browser owner was previously closed', () => {
  useChatStore.setState((state) => ({
    threadStates: {
      ...state.threadStates,
      'thread-b': {
        ...DEFAULT_THREAD_STATE,
        workspaceForegroundSurfaceId: browser.id,
        workspaceSurface: 'browser',
        workspacePreview: { port: 5324, path: '/B' },
      },
    },
  }));
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'close-surface',
    surfaceId: browser.id,
    entitlement: { kind: 'user', reason: 'close-button' },
  });
  useChatStore.getState().setCurrentThread('thread-b');
  const layout = useF307ExperienceWorkbenchStore.getState().layout;
  expect(layout.surfaces.find((surface) => surface.id === browser.id)?.resultTargetRef).toEqual(
    createBrowserSurface({ ownerKey: 'browser-b', port: 5324, path: '/B' }).resultTargetRef,
  );
  expect(layout.recentlyClosed).toHaveLength(0);
});

it('preserves the browsed worktree alias when remembering a canonical file owner', () => {
  useChatStore.setState({
    workspaceWorktreeId: 'browsed-alias',
    currentProjectPath: '/fixture/project',
    workspaceWorktreeAliases: { 'browsed-alias': 'shared-worktree' },
    workspaceWorktreeAliasesProjectPath: '/fixture/project',
  });
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'open-surface',
    surface: fileB,
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
  expect(useChatStore.getState().workspaceWorktreeId).toBe('browsed-alias');
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('B.md');
});

it('restores an exact preview path even when two conversations share the browser owner id', () => {
  useChatStore.setState((state) => ({
    threadStates: {
      ...state.threadStates,
      'thread-b': {
        ...DEFAULT_THREAD_STATE,
        workspaceForegroundSurfaceId: browser.id,
        workspaceSurface: 'browser',
        workspacePreview: { port: 5324, path: '/B' },
      },
    },
  }));
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'activate-surface',
    surfaceId: browser.id,
    entitlement: { kind: 'user', reason: 'surface-tab' },
  });
  lockCurrentWorkspace();
  useChatStore.getState().setCurrentThread('thread-b');
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[1].resultTargetRef).toEqual(
    browser.resultTargetRef,
  );
  useChatStore.getState().disablePresentationLock();
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[1].resultTargetRef).toEqual(
    createBrowserSurface({ ownerKey: 'browser-b', port: 5324, path: '/B' }).resultTargetRef,
  );
});

it('keeps the same file object and focus while locked, and returns to B’s existing browser owner on unlock', () => {
  useChatStore.setState((state) => ({
    threadStates: {
      ...state.threadStates,
      'thread-b': {
        ...DEFAULT_THREAD_STATE,
        workspaceForegroundSurfaceId: browser.id,
        workspaceSurface: 'browser',
        workspacePreview: { port: 5324, path: '/browser-owner-probe' },
      },
    },
  }));
  lockCurrentWorkspace();
  useF307ExperienceWorkbenchStore.getState().enterFocusMode(fileA.id);
  useChatStore.getState().setCurrentThread('thread-b');
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[0]).toBe(fileA);
  expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBe(fileA.id);
  useChatStore.getState().disablePresentationLock();
  expect(useF307ExperienceWorkbenchStore.getState().layout.activeSurfaceId).toBe(browser.id);
  expect(useF307ExperienceWorkbenchStore.getState().layout.surfaces[1]).toBe(browser);
  expect(useF307ExperienceWorkbenchStore.getState().focusSurfaceId).toBeNull();
});

it('remembers the listed source worktree when a resolved file owner uses a durable root id', () => {
  const resolved = createFileSurface({
    worktreeId: `f063_root_v1_${'a'.repeat(64)}`,
    path: 'B.md',
    scrollToLine: 42,
    navigationOrigin: { kind: 'file-tree', worktreeId: 'browsed-alias' },
  });
  useChatStore.setState({
    workspaceWorktreeId: 'browsed-alias',
    currentProjectPath: '/fixture/project',
    workspaceWorktreeAliases: {},
    workspaceWorktreeAliasesProjectPath: '/fixture/project',
  });
  useF307ExperienceWorkbenchStore.getState().dispatch({
    type: 'open-surface',
    surface: resolved,
    entitlement: { kind: 'user', reason: 'workspace-home-selection' },
  });
  const chat = useChatStore.getState();
  expect(chat.workspaceForegroundSurfaceId).toBe(resolved.id);
  expect(chat.workspaceWorktreeId).toBe('browsed-alias');
  expect(chat.workspaceOpenFilePath).toBe('B.md');
  expect(chat.threadStates['thread-a'].workspaceWorktreeId).toBe('browsed-alias');
});

it('restores the exact file from its listed source coordinate after workbench hydration', () => {
  unbind();
  const resolvedA = createFileSurface({
    worktreeId: `f063_root_v1_${'a'.repeat(64)}`,
    path: 'A.md',
    scrollToLine: 7,
    navigationOrigin: { kind: 'file-tree', worktreeId: 'browsed-alias' },
  });
  useF307ExperienceWorkbenchStore.setState({
    hydrated: false,
    layout: { ...createInitialWorkbenchState(), surfaces: [resolvedA], activeSurfaceId: resolvedA.id },
  });
  useChatStore.setState({
    workspaceForegroundSurfaceId: resolvedA.id,
    workspaceWorktreeId: 'browsed-alias',
    workspaceOpenFilePath: 'B.md',
    workspaceOpenFileLine: 42,
    workspaceOpenTabs: ['B.md'],
    currentProjectPath: '/fixture/project',
    workspaceWorktreeAliases: {},
    workspaceWorktreeAliasesProjectPath: '/fixture/project',
  });
  unbind = bindWorkspaceForeground();
  useF307ExperienceWorkbenchStore.setState({ hydrated: true });
  const { layout } = useF307ExperienceWorkbenchStore.getState();
  const active = layout.surfaces.find((surface) => surface.id === layout.activeSurfaceId);
  if (!active) throw new Error('the original durable file owner must remain present');
  expect(active.id).toBe(resolvedA.id);
  expect(resolveFileTarget(active)).toMatchObject({ path: 'B.md', scrollToLine: 42 });
  expect(active.navigationOrigin).toEqual(resolvedA.navigationOrigin);
});
