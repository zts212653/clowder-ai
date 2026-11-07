import type { SuggestionView } from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

/**
 * F335 交付二：回话下面那一排的页面缓存。每条对话打开时取一次，之后靠 `suggestion_updated` 原地换一行。
 * The server is the truth; this only remembers the latest revision of each row the page has seen.
 */
interface SuggestionState {
  byThread: Record<string, Record<string, SuggestionView>>;
  /** When each conversation's rows were last read from the server (drives the self-change recheck). */
  loadedAt: Record<string, number>;
  replaceThread(threadId: string, rows: readonly SuggestionView[]): void;
  upsert(row: SuggestionView): void;
}

export const useSuggestionStore = create<SuggestionState>((set) => ({
  byThread: {},
  loadedAt: {},
  replaceThread: (threadId, rows) =>
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: Object.fromEntries(rows.map((row) => [row.id, row])) },
      loadedAt: { ...state.loadedAt, [threadId]: Date.now() },
    })),
  upsert: (row) =>
    set((state) => {
      const rows = state.byThread[row.threadId] ?? {};
      const current = rows[row.id];
      if (current && current.revision > row.revision) return state;
      return { byThread: { ...state.byThread, [row.threadId]: { ...rows, [row.id]: row } } };
    }),
}));

/** The one row a message carries (newest wins if an old one was ever left behind). */
export function rowForMessage(
  rows: Record<string, SuggestionView> | undefined,
  messageId: string,
): SuggestionView | undefined {
  if (!rows) return undefined;
  let found: SuggestionView | undefined;
  for (const row of Object.values(rows)) {
    if (row.messageId === messageId && (!found || row.createdAt > found.createdAt)) found = row;
  }
  return found;
}

export async function loadThreadSuggestions(threadId: string): Promise<void> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/suggestions`);
  if (!response.ok) return;
  const body = (await response.json()) as { suggestions?: SuggestionView[] };
  if (Array.isArray(body.suggestions)) useSuggestionStore.getState().replaceThread(threadId, body.suggestions);
}

export type SuggestionDecision = 'apply' | 'undo' | 'dismiss';

/** One click on a row; the reply carries the row's next revision (or why it did not happen). */
export async function decideSuggestion(
  row: SuggestionView,
  decision: SuggestionDecision,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const response = await apiFetch(`/api/suggestions/${encodeURIComponent(row.id)}/${decision}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: row.revision }),
  });
  const body = (await response.json().catch(() => null)) as
    | (SuggestionView & { error?: string; suggestion?: SuggestionView })
    | null;
  if (response.ok && body?.id) {
    useSuggestionStore.getState().upsert(body);
    return { ok: true };
  }
  // Part of it happened and could not be taken back: the row now says what was done.
  if (body?.suggestion?.id) useSuggestionStore.getState().upsert(body.suggestion);
  if (response.status === 409) void loadThreadSuggestions(row.threadId);
  return { ok: false, error: body?.error ?? `HTTP ${response.status}` };
}
