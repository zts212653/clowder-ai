import type { PresentationLockView } from '@/stores/chat-types';
import { type ChatState, useChatStore } from '@/stores/chatStore';
import { areWorktreeIdsEquivalent, scopeWorktreeAliases } from '@/utils/worktree-id-alias';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import {
  createBrowserSurface,
  createFileSurface,
  resolveBrowserTarget,
  resolveFileTarget,
} from './real-surface-adapters';
import type { WorkbenchAction, WorkbenchLayoutState, WorkspaceSurfaceDescriptor } from './workbench-contract';

/** The resolved owner keeps its durable root; per-thread navigation uses its listed source coordinate. */
function resolveFileCoordinate(surface: WorkspaceSurfaceDescriptor) {
  const file = resolveFileTarget(surface);
  const origin = surface.navigationOrigin;
  return file && origin?.kind === 'file-tree' && origin.worktreeId ? { ...file, worktreeId: origin.worktreeId } : file;
}

/** Capture coordinates only. The descriptor, live renderer and draft retain their original owners. */
function captureVisibleWorkspace(surface: WorkspaceSurfaceDescriptor): PresentationLockView {
  const chat = useChatStore.getState();
  const file = resolveFileTarget(surface);
  const sameLockedFile =
    !chat.presentationLock ||
    (chat.presentationLock.filePath === file?.path && chat.presentationLock.worktreeId === file?.worktreeId);
  return {
    surfaceId: surface.id,
    worktreeId: file?.worktreeId ?? chat.workspaceWorktreeId,
    filePath: file?.path ?? null,
    line: file?.scrollToLine ?? null,
    tabs: file ? [file.path] : [],
    scrollTop: file && sameLockedFile ? chat.workspaceScrollTop : null,
  };
}

export function lockCurrentWorkspace(): void {
  const workbench = useF307ExperienceWorkbenchStore.getState();
  const surface = workbench.layout.surfaces.find((item) => item.id === workbench.layout.activeSurfaceId);
  if (!surface) return;
  const visible = captureVisibleWorkspace(surface);
  const file = resolveFileCoordinate(surface);
  const browser = resolveBrowserTarget(surface);
  useChatStore.getState().setWorkspaceForegroundSurfaceId(surface.id, {
    ...(file && { file }),
    ...(browser && { preview: { port: browser.port, path: browser.path } }),
  });
  useChatStore.getState().enablePresentationLock(visible);
}

function resolveThreadFile(surface: WorkspaceSurfaceDescriptor, chat: ChatState): WorkspaceSurfaceDescriptor | null {
  const file = resolveFileTarget(surface);
  const coordinate = resolveFileCoordinate(surface);
  if (!file || !coordinate || !chat.workspaceOpenFilePath) return null;
  const aliases = scopeWorktreeAliases(
    chat.workspaceWorktreeAliases,
    chat.workspaceWorktreeAliasesProjectPath,
    chat.currentProjectPath,
  );
  if (!areWorktreeIdsEquivalent(coordinate.worktreeId, chat.workspaceWorktreeId, aliases)) return null;
  if (file.path === chat.workspaceOpenFilePath && file.scrollToLine === chat.workspaceOpenFileLine) return null;
  return createFileSurface({
    worktreeId: file.worktreeId,
    path: chat.workspaceOpenFilePath,
    scrollToLine: chat.workspaceOpenFileLine,
    ...(surface.navigationOrigin?.kind === 'file-tree' && { navigationOrigin: surface.navigationOrigin }),
    rootSelection: surface.rootSelection,
  });
}

function resolveThreadBrowser(surface: WorkspaceSurfaceDescriptor, chat: ChatState): WorkspaceSurfaceDescriptor | null {
  const browser = resolveBrowserTarget(surface);
  if (!browser || chat.workspaceSurface !== 'browser' || chat.workspacePreview.port === undefined) return null;
  if (browser.port === chat.workspacePreview.port && browser.path === chat.workspacePreview.path) return null;
  return createBrowserSurface({ ownerKey: browser.ownerKey, ...chat.workspacePreview });
}

function resolveThreadReturn(layout: WorkbenchLayoutState, chat: ChatState): WorkbenchAction | null {
  const id = chat.workspaceForegroundSurfaceId;
  // An old snapshot has no reference; leave its existing projection intact. Null is explicit Home.
  if (!id) return null;
  const existing = layout.surfaces.find((surface) => surface.id === id);
  const referenced = existing ?? layout.recentlyClosed.find((surface) => surface.id === id);
  if (!referenced) return null;
  const restored = resolveThreadFile(referenced, chat) ?? resolveThreadBrowser(referenced, chat);
  if (existing && layout.activeSurfaceId === id && !restored) return null;
  const entitlement = { kind: 'user', reason: 'return-origin' } as const;
  return restored
    ? { type: 'open-surface', surface: restored, entitlement }
    : { type: existing ? 'activate-surface' : 'restore-surface', surfaceId: id, entitlement };
}

/** Explicit navigation may reveal the already-active owner after the user chose Home. */
export function rememberWorkspaceForeground(): void {
  const workbench = useF307ExperienceWorkbenchStore.getState();
  const surface = workbench.layout.surfaces.find((item) => item.id === workbench.layout.activeSurfaceId);
  const chat = useChatStore.getState();
  const file = surface && resolveFileCoordinate(surface);
  const browser = surface && resolveBrowserTarget(surface);
  chat.setWorkspaceForegroundSurfaceId(surface?.id ?? null, {
    ...(file && { file }),
    ...(browser && { preview: { port: browser.port, path: browser.path } }),
  });
  const lock = useChatStore.getState().presentationLock;
  if (lock && surface) {
    useChatStore.getState().replacePresentationLockTarget({ ...lock, ...captureVisibleWorkspace(surface) });
  }
}

/** One bridge between the existing per-thread reference and F307's canonical topology. */
export function bindWorkspaceForeground(): () => void {
  let applying = false;
  const restoreForeground = () => {
    const workbench = useF307ExperienceWorkbenchStore.getState();
    if (!workbench.hydrated || applying) return;
    const action = resolveThreadReturn(workbench.layout, useChatStore.getState());
    if (!action) return;
    applying = true;
    try {
      if (action.type === 'open-surface') workbench.exitFocusMode();
      workbench.dispatch(action);
    } finally {
      applying = false;
    }
  };
  const rememberForeground = () => {
    if (applying) return;
    applying = true;
    try {
      rememberWorkspaceForeground();
    } finally {
      applying = false;
    }
  };
  const unsubscribeChat = useChatStore.subscribe((state, previous) => {
    // Explicit local file entries belong to the Panel/request consumer. Restoring here would
    // retarget the previous permanent tab before that consumer can open the new preview.
    if (
      state.currentThreadId === previous.currentThreadId &&
      ((state._workspaceFileSetAt.ts !== previous._workspaceFileSetAt.ts &&
        (!state._workspaceFileSetAt.threadId || state._workspaceFileSetAt.threadId === state.currentThreadId)) ||
        (state.workspaceOpenRequest?.target.kind === 'file' &&
          state.workspaceOpenRequest.revision !== previous.workspaceOpenRequest?.revision &&
          (!state.workspaceOpenRequest.threadId || state.workspaceOpenRequest.threadId === state.currentThreadId)))
    )
      return;
    if (
      state.currentThreadId !== previous.currentThreadId ||
      state.workspaceForegroundSurfaceId !== previous.workspaceForegroundSurfaceId ||
      state.workspaceOpenFilePath !== previous.workspaceOpenFilePath ||
      state.workspaceOpenFileLine !== previous.workspaceOpenFileLine ||
      state.workspaceWorktreeId !== previous.workspaceWorktreeId ||
      state.workspacePreview.port !== previous.workspacePreview.port ||
      state.workspacePreview.path !== previous.workspacePreview.path ||
      (previous.presentationLock && !state.presentationLock)
    ) {
      restoreForeground();
    }
  });
  const unsubscribeWorkbench = useF307ExperienceWorkbenchStore.subscribe((state, previous) => {
    if (!state.hydrated) return;
    if (!previous.hydrated) {
      restoreForeground();
      return;
    }
    const active = state.layout.surfaces.find((surface) => surface.id === state.layout.activeSurfaceId);
    const before = previous.layout.surfaces.find((surface) => surface.id === previous.layout.activeSurfaceId);
    if (
      active?.id !== before?.id ||
      active?.ownerStateRef.key !== before?.ownerStateRef.key ||
      active?.resultTargetRef?.key !== before?.resultTargetRef?.key
    ) {
      rememberForeground();
    }
  });
  restoreForeground();
  return () => {
    unsubscribeChat();
    unsubscribeWorkbench();
  };
}
