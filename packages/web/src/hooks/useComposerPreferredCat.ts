'use client';

import { useCallback } from 'react';
import type { ComposerPreferredCatControl } from '@/components/ComposerPreferredCatSection';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { executeSidebarFieldCommand } from '@/utils/sidebar-commands';
import { useThreadDisplayInfo } from './useThreadDisplayInfo';

const EMPTY_CATS: readonly string[] = [];

/** Existing-thread adapter for the original durable preferredCats field. */
export function useComposerPreferredCat(
  threadId: string,
  enabled: boolean,
  onChanged: () => void,
): ComposerPreferredCatControl | null {
  const { currentThread, setExactThread } = useThreadDisplayInfo(threadId, enabled);
  const updateThreadPreferredCats = useChatStore((state) => state.updateThreadPreferredCats);
  const selectedCatIds = currentThread?.preferredCats ?? EMPTY_CATS;
  const change = useCallback(
    async (nextIds: string[]) => {
      if (!enabled) return false;
      const preferredCats = [...nextIds];
      const ok = await executeSidebarFieldCommand({
        threadId,
        field: 'preferredCats',
        value: preferredCats,
        request: (signal) =>
          apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ preferredCats }),
            signal,
          }),
      });
      if (!ok) return false;
      updateThreadPreferredCats(threadId, preferredCats);
      setExactThread((previous) =>
        previous?.id === threadId && !('error' in previous) ? { ...previous, preferredCats } : previous,
      );
      onChanged();
      return true;
    },
    [enabled, onChanged, setExactThread, threadId, updateThreadPreferredCats],
  );

  if (!enabled) return null;
  return { selectedCatIds, onChange: change };
}
