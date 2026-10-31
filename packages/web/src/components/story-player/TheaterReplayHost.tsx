'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { captureChatReadingBeforeLayoutChange } from '@/utils/chat-layout-change';
import { useShellPresentation } from '../shell/shell-presentation';
import { subscribeTheaterReplay } from '../ThreadSidebar/theater-navigation';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { createThreadReplaySurface } from '../workbench/thread-replay-surface';
import { TheaterOverlay } from './TheaterOverlay';
import { TheaterReplayContent } from './TheaterReplayContent';

/** Root-level F252 replay host so Launcher/sidebar events survive sidebar collapse. */
export function TheaterReplayHost() {
  const threads = useChatStore((state) => state.threads);
  const isV2 = useShellPresentation() === 'v2';
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    let pendingHydration: (() => void) | null = null;
    const stop = subscribeTheaterReplay((nextThreadId) => {
      if (!isV2) {
        captureChatReadingBeforeLayoutChange();
        setThreadId(nextThreadId);
        return;
      }
      const chat = useChatStore.getState();
      const surface = createThreadReplaySurface(
        nextThreadId,
        '线程回放',
        chat.threads.find((thread) => thread.id === nextThreadId)?.title,
      );
      if (!surface) return;
      pendingHydration?.();
      pendingHydration = null;
      const workbench = useF307ExperienceWorkbenchStore;
      if (!workbench.getState().layout.surfaces.some((item) => item.id === surface.id))
        captureChatReadingBeforeLayoutChange();
      const open = () =>
        workbench.getState().dispatch({
          type: 'open-surface',
          surface,
          entitlement: { kind: 'user', reason: 'workspace-home-selection' },
        });
      if (workbench.getState().hydrated) open();
      else
        pendingHydration = workbench.subscribe((state) => {
          if (!state.hydrated) return;
          pendingHydration?.();
          pendingHydration = null;
          open();
        });
      // The mounted WorkspacePanel hydrates its original F284 snapshot before this event opens replay.
      chat.setRightPanelMode('workspace');
      chat.setRightPanelOpen(true);
    });
    return () => {
      stop();
      pendingHydration?.();
    };
  }, [isV2]);

  if (isV2 || !threadId) return null;
  return (
    <TheaterOverlay
      open
      onClose={() => setThreadId(null)}
      title={threads.find((thread) => thread.id === threadId)?.title ?? undefined}
    >
      <TheaterReplayContent threadId={threadId} />
    </TheaterOverlay>
  );
}
