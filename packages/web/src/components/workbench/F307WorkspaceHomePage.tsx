'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import {
  type WorkspaceDevSurface,
  WorkspaceLauncher,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import type { LauncherWorkspaceSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import { WorkspaceNowSurface } from '@/components/workspace/WorkspaceNowSurface';
import { createAgentRunSurface, createFileSurface } from './real-surface-adapters';
import { workspaceHomeDestinationToSurface } from './workspace-home-adapter';

function requiresWorktreeOwner(destination: WorkspaceLauncherDestination): boolean {
  return destination.kind === 'surface' && ['files', 'changes', 'terminal'].includes(destination.id);
}

export function F307WorkspaceHomePage({
  threadId,
  defaultCatId,
  onSelectDevSurface,
  onSelectSurface,
  worktreeId,
  worktreeLoading = false,
  worktreeError = null,
  openFilePath,
  preview,
  repository,
  workspaceSearch,
}: {
  threadId?: string;
  defaultCatId: string;
  onSelectDevSurface: (surface: WorkspaceDevSurface) => void;
  onSelectSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  worktreeId: string | null;
  worktreeLoading?: boolean;
  worktreeError?: string | null;
  openFilePath: string | null;
  preview: { port?: number; path: string };
  repository?: { name: string; branch: string };
  workspaceSearch?: LauncherWorkspaceSearch;
}) {
  const [pendingDestination, setPendingDestination] = useState<WorkspaceLauncherDestination | null>(null);
  const [destinationMessage, setDestinationMessage] = useState<string | null>(null);

  const selectDestination = (destination: WorkspaceLauncherDestination) => {
    const surface = workspaceHomeDestinationToSurface(destination, {
      threadId,
      worktreeId,
      openFilePath,
      preview,
    });
    if (surface) {
      setPendingDestination(null);
      setDestinationMessage(null);
      onSelectSurface(surface);
      return;
    }
    if (!requiresWorktreeOwner(destination)) return;
    if (worktreeLoading) {
      setPendingDestination(destination);
      setDestinationMessage(`正在读取工作区，随后打开${destination.label}…`);
      return;
    }
    setPendingDestination(null);
    setDestinationMessage(worktreeError ?? `当前项目没有可用工作区，暂时无法打开${destination.label}`);
  };

  useEffect(() => {
    if (!pendingDestination) return;
    if (!worktreeId) {
      if (!worktreeLoading) {
        setDestinationMessage(worktreeError ?? `当前项目没有可用工作区，暂时无法打开${pendingDestination.label}`);
        setPendingDestination(null);
      }
      return;
    }
    const surface = workspaceHomeDestinationToSurface(pendingDestination, {
      threadId,
      worktreeId,
      openFilePath,
      preview,
    });
    if (!surface) return;
    setPendingDestination(null);
    setDestinationMessage(null);
    onSelectSurface(surface);
  }, [
    onSelectSurface,
    openFilePath,
    pendingDestination,
    preview,
    threadId,
    worktreeError,
    worktreeId,
    worktreeLoading,
  ]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--console-panel-bg)]" data-testid="f307-workspace-home-page">
      <WorkspaceNowSurface
        repository={repository}
        onSelectExecution={(execution) => onSelectSurface(createAgentRunSurface({ execution }))}
      />
      {destinationMessage && (
        <div className="mx-auto w-full max-w-4xl px-5 pt-3">
          <div
            className="rounded-xl border border-cafe-subtle bg-cafe-surface px-4 py-3 text-xs text-cafe-secondary"
            role="status"
            aria-live="polite"
            data-testid="f307-destination-admission-status"
          >
            {destinationMessage}
          </div>
        </div>
      )}
      <WorkspaceLauncher
        threadId={threadId}
        defaultCatId={defaultCatId}
        onSelectDevSurface={onSelectDevSurface}
        workspaceSearch={
          workspaceSearch
            ? {
                ...workspaceSearch,
                onOpenResult: (path, line) => {
                  workspaceSearch.onOpenResult(path, line);
                  if (worktreeId) onSelectSurface(createFileSurface({ worktreeId, path, scrollToLine: line }));
                },
              }
            : undefined
        }
        onSelectDestination={selectDestination}
      />
    </div>
  );
}
