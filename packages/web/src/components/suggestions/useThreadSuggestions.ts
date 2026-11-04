'use client';

import { type SuggestionView, suggestionNextSelfChangeAt } from '@cat-cafe/shared';
import { useEffect } from 'react';
import { loadThreadSuggestions, useSuggestionStore } from './suggestion-store';

/** Never read the same conversation again sooner than this (a server clock still short of the deadline). */
const MIN_RECHECK_MS = 10_000;
const SKEW_MARGIN_MS = 500;
const MAX_TIMER_MS = 2 ** 31 - 1;

function nextSelfChangeAt(rows: Record<string, SuggestionView> | undefined): number | null {
  let next: number | null = null;
  for (const row of Object.values(rows ?? {})) {
    const at = suggestionNextSelfChangeAt(row);
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Read this conversation's rows when it opens, after the socket reconnects (pushes missed while away), and again when
 * a row changes on its own while the page stays open — a pill expiring as 「不理」, a stuck click freeing up.
 * Live changes from clicks and cats arrive through `suggestion_updated`.
 */
export function useThreadSuggestionsSync(threadId: string | null | undefined, connected = true): void {
  useEffect(() => {
    if (threadId && connected) void loadThreadSuggestions(threadId).catch(() => {});
  }, [threadId, connected]);
  const nextAt = useSuggestionStore((state) => (threadId ? nextSelfChangeAt(state.byThread[threadId]) : null));
  // Each read re-arms the timer, so a server whose clock is still short of the deadline is asked again later.
  const loadedAt = useSuggestionStore((state) => (threadId ? (state.loadedAt[threadId] ?? 0) : 0));
  useEffect(() => {
    if (!threadId || !connected || nextAt === null) return;
    const wait = Math.max(nextAt - Date.now(), loadedAt + MIN_RECHECK_MS - Date.now(), 0);
    const delay = Math.min(wait + SKEW_MARGIN_MS, MAX_TIMER_MS);
    const timer = setTimeout(() => void loadThreadSuggestions(threadId).catch(() => {}), delay);
    return () => clearTimeout(timer);
  }, [threadId, connected, nextAt, loadedAt]);
}
