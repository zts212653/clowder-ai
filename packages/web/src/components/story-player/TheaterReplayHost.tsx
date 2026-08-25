'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { subscribeTheaterReplay } from '../ThreadSidebar/theater-navigation';
import { TheaterOverlay } from './TheaterOverlay';
import { TheaterReplayContent } from './TheaterReplayContent';

/** Root-level F252 replay host so Launcher/sidebar events survive sidebar collapse. */
export function TheaterReplayHost() {
  const threads = useChatStore((state) => state.threads);
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => subscribeTheaterReplay(setThreadId), []);

  if (!threadId) return null;
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
