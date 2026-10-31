import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { createCapabilityEvolutionWorkspaceSurface } from './capability-evolution-workspace-adapter';
import {
  createBrowserSurface,
  createTerminalSurface,
  createWorkspaceDestinationSurface,
} from './real-surface-adapters';
import { createThreadReplaySurface } from './thread-replay-surface';

export interface WorkspaceHomeAdapterContext {
  threadId?: string;
  threadTitle?: string | null;
  worktreeId: string | null;
  /** The selected list entry's API identity; list selection remains worktreeId. */
  canonicalWorktreeId?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
}

export function workspaceHomeDestinationToSurface(
  destination: WorkspaceLauncherDestination,
  context: WorkspaceHomeAdapterContext,
): WorkspaceSurfaceDescriptor | null {
  if (destination.kind === 'action' && destination.id === 'theater') {
    return context.threadId
      ? createThreadReplaySurface(context.threadId, destination.label, context.threadTitle)
      : null;
  }
  if (destination.kind === 'workspace') return createCapabilityEvolutionWorkspaceSurface(context.threadId);
  if (destination.kind === 'surface' && destination.id === 'files') {
    return createWorkspaceDestinationSurface(destination, context.threadId, context.worktreeId);
  }
  if (destination.kind === 'surface' && destination.id === 'browser') {
    return createBrowserSurface({
      ownerKey: context.worktreeId ?? 'current-project',
      port: context.preview.port,
      path: context.preview.path,
    });
  }
  if (destination.kind === 'surface' && destination.id === 'terminal') {
    return context.worktreeId
      ? createTerminalSurface({ worktreeId: context.canonicalWorktreeId ?? context.worktreeId })
      : null;
  }
  return createWorkspaceDestinationSurface(destination, context.threadId, context.worktreeId);
}
