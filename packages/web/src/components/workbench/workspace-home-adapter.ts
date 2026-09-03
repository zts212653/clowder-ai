import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import type { WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { createCapabilityEvolutionWorkspaceSurface } from './capability-evolution-workspace-adapter';
import {
  createBrowserSurface,
  createTerminalSurface,
  createWorkspaceDestinationSurface,
} from './real-surface-adapters';

export interface WorkspaceHomeAdapterContext {
  threadId?: string;
  worktreeId: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
}

export function workspaceHomeDestinationToSurface(
  destination: WorkspaceLauncherDestination,
  context: WorkspaceHomeAdapterContext,
): WorkspaceSurfaceDescriptor | null {
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
    return context.worktreeId ? createTerminalSurface({ worktreeId: context.worktreeId }) : null;
  }
  return createWorkspaceDestinationSurface(destination, context.threadId, context.worktreeId);
}
