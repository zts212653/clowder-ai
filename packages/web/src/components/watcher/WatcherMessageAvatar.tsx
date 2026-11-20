'use client';

import type { WatcherPanelRound } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SuggestionAvatar } from '../suggestions/SuggestionAvatar';

/** The owner ledger knows this round's observer; cat history and blind exports keep their anonymity. */
export function WatcherMessageAvatar({ roundId }: { roundId?: string }) {
  const [identity, setIdentity] = useState<{ roundId: string; catId: string }>();
  useEffect(() => {
    if (!roundId) return;
    const abort = new AbortController();
    void apiFetch(`/api/watcher/panel/rounds/${encodeURIComponent(roundId)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const round: WatcherPanelRound = await response.json();
        // Count every member, including quiet/failed ones: one speaker in a panel is still anonymous.
        if (abort.signal.aborted || round.roundId !== roundId || round.members.length !== 1) return;
        const member = round.members[0];
        if (member?.status === 'spoke' && member.catId) setIdentity({ roundId, catId: member.catId });
      })
      .catch(() => {
        // Unavailable identity stays unknown; never borrow the worker or the current primary.
      });
    return () => abort.abort();
  }, [roundId]);
  return <SuggestionAvatar catId={identity?.roundId === roundId ? identity?.catId : undefined} watcher />;
}
