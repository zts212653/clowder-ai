import { useCallback, useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';
import { workspaceChromeCopy } from './workspace-chrome.shell-copy';
import { type WorkspaceHomeAdapterContext, workspaceHomeDestinationToSurface } from './workspace-home-adapter';

export interface WorkspaceDestinationAdmission {
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
  message: string | null;
}

/**
 * The canonical destination objects keep their original single-language label/description (audit row 44):
 * surfaces created from them would otherwise ignore the shell language on their tab and context line.
 * The localized words come from the workbench chrome dictionary this hook already reads — only the v2
 * display layer changes (classic keeps the raw stored words and reads nothing new); destination identity,
 * worktree admission and every other destination stay untouched.
 */
function localizeSurfaceWords(
  surface: WorkspaceSurfaceDescriptor,
  destination: WorkspaceLauncherDestination,
  words: { voiceSurface: { label: string; description: string } },
  isV2: boolean,
): WorkspaceSurfaceDescriptor {
  if (isV2 && destination.kind === 'host' && destination.id === 'voice') {
    return { ...surface, title: words.voiceSurface.label, context: words.voiceSurface.description };
  }
  return surface;
}

/** Home and its disposable tools menu share the original worktree admission, not another destination store. */
export function useWorkspaceDestinationAdmission({
  context,
  worktreeLoading,
  worktreeError,
  onSelectSurface,
  enabled = true,
}: {
  context: WorkspaceHomeAdapterContext;
  worktreeLoading: boolean;
  worktreeError: string | null;
  onSelectSurface: (surface: WorkspaceSurfaceDescriptor) => void;
  enabled?: boolean;
}): WorkspaceDestinationAdmission {
  const presentation = useShellPresentation();
  const t = useShellCopy(workspaceChromeCopy);
  const isV2 = presentation === 'v2';
  const [pending, setPending] = useState<{ threadId?: string; destination: WorkspaceLauncherDestination } | null>(null);
  const [notice, setNotice] = useState<{ threadId?: string; message: string } | null>(null);
  const onSelectDestination = useCallback(
    (destination: WorkspaceLauncherDestination) => {
      if (!enabled) return;
      const surface = workspaceHomeDestinationToSurface(destination, context);
      if (surface) {
        setPending(null);
        setNotice(null);
        onSelectSurface(localizeSurfaceWords(surface, destination, t, isV2));
      } else if (destination.kind === 'surface' && ['files', 'changes', 'terminal'].includes(destination.id)) {
        setPending(worktreeLoading ? { threadId: context.threadId, destination } : null);
        setNotice({
          threadId: context.threadId,
          message: worktreeLoading
            ? t.destinationLoading(destination.label)
            : (worktreeError ?? t.destinationUnavailable(destination.label)),
        });
      }
    },
    [context, enabled, onSelectSurface, t, isV2, worktreeError, worktreeLoading],
  );

  useEffect(() => {
    if (!pending) return;
    if (!enabled || pending.threadId !== context.threadId) {
      setPending(null);
      setNotice(null);
      return;
    }
    const surface = workspaceHomeDestinationToSurface(pending.destination, context);
    if (surface) {
      setPending(null);
      setNotice(null);
      onSelectSurface(localizeSurfaceWords(surface, pending.destination, t, isV2));
    } else if (!worktreeLoading) {
      setPending(null);
      setNotice({
        threadId: context.threadId,
        message: worktreeError ?? t.destinationUnavailable(pending.destination.label),
      });
    }
  }, [context, enabled, onSelectSurface, pending, t, isV2, worktreeError, worktreeLoading]);

  return { onSelectDestination, message: notice && notice.threadId === context.threadId ? notice.message : null };
}
