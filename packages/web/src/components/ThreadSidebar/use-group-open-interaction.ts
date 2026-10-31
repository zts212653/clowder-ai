import { useCallback, useRef, useState } from 'react';
import { type AttentionCluster, resolveAttentionClusterOpen } from './attention-clusters';

interface OpenIntent {
  anchor: string;
  open: boolean;
  searchGeneration: number;
}

interface InteractionState {
  query: string;
  searchGeneration: number;
  searchChoices: Record<string, boolean>;
  pending: OpenIntent[];
}

/** Pending clicks affect presentation immediately; only the canonical writer confirms preferences. */
export function useGroupOpenInteraction(
  confirmedOpen: Readonly<Record<string, boolean>>,
  currentThreadId: string,
  searchQuery: string,
) {
  const query = searchQuery.trim().toLocaleLowerCase();
  const [state, setState] = useState<InteractionState>({
    query,
    searchGeneration: 0,
    searchChoices: {},
    pending: [],
  });
  const latest = useRef(state);
  const update = useCallback((next: InteractionState) => {
    latest.current = next;
    setState(next);
  }, []);

  // A new query gets fresh automatic recall, even if the same text is entered again later.
  if (state.query !== query) {
    update({ ...state, query, searchGeneration: state.searchGeneration + 1, searchChoices: {} });
  }

  // The state dependency invalidates consumers' row memos; the ref also sees consecutive clicks before a render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state is the render signal for the same interaction held in latest.
  const isOpen = useCallback(
    (cluster: AttentionCluster) => {
      const current = latest.current;
      const pending = [...current.pending].reverse().find((intent) => intent.anchor === cluster.anchor);
      if (current.query) {
        if (pending?.searchGeneration === current.searchGeneration) return pending.open;
        if (Object.hasOwn(current.searchChoices, cluster.anchor)) return current.searchChoices[cluster.anchor] === true;
      }
      const preferences = pending ? { ...confirmedOpen, [cluster.anchor]: pending.open } : confirmedOpen;
      return resolveAttentionClusterOpen(cluster, preferences, currentThreadId, current.query);
    },
    [confirmedOpen, currentThreadId, state],
  );

  const begin = useCallback(
    (anchor: string, open: boolean): OpenIntent => {
      const current = latest.current;
      const intent = { anchor, open, searchGeneration: current.searchGeneration };
      update({ ...current, pending: [...current.pending, intent] });
      return intent;
    },
    [update],
  );

  const settle = useCallback(
    (intent: OpenIntent, saved: boolean) => {
      const current = latest.current;
      const searchChoices =
        saved && current.query && intent.searchGeneration === current.searchGeneration
          ? { ...current.searchChoices, [intent.anchor]: intent.open }
          : current.searchChoices;
      update({ ...current, searchChoices, pending: current.pending.filter((entry) => entry !== intent) });
    },
    [update],
  );

  return { isOpen, begin, settle };
}
