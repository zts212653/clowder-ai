import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

export const FIRST_RUN_ENTRY_GUIDE_ID = 'first-run-entry';
export const FIRST_RUN_ENTRY_RECEIPT_PATH = '/api/config/onboarding/entry';
export type EntryTerminalStatus = 'dismissed' | 'completed';
export type PendingEntryReceipt = { status: EntryTerminalStatus; sessionId: string; threadId: string };
type GuideSnapshot = ReturnType<typeof useGuideStore.getState>;

export function entryReceiptTransition(
  state: GuideSnapshot,
  previous: GuideSnapshot,
  threadId: string,
): PendingEntryReceipt | null {
  const own = (session: GuideSnapshot['session']) =>
    session?.flow.id === FIRST_RUN_ENTRY_GUIDE_ID && session.threadId === threadId;
  if (own(state.session) && state.session?.phase === 'complete') {
    if (!own(previous.session) || previous.session?.phase !== 'complete')
      return { status: 'completed', sessionId: state.session.sessionId, threadId };
  }
  const before = previous.session;
  if (!own(before) || !before || state.session) return null;
  if (before.phase === 'complete' && previous.completionPersisted) return null;
  if (!state.completedGuides.has(`${threadId}::${FIRST_RUN_ENTRY_GUIDE_ID}`)) return null;
  return { status: 'dismissed', sessionId: before.sessionId, threadId };
}

export function failEntryReceipt(write: PendingEntryReceipt | null): void {
  if (write?.status !== 'completed') return;
  const state = useGuideStore.getState();
  state.markCompletionFailed(write.sessionId);
  if (state.session && state.session.sessionId !== write.sessionId) return;
  const completedGuides = new Set(state.completedGuides);
  completedGuides.delete(`${write.threadId}::${FIRST_RUN_ENTRY_GUIDE_ID}`);
  useGuideStore.setState({ completedGuides });
}

/** The existing session-owned preferences are the sole durable owner of this reminder. */
export async function saveEntryReceipt(intent: EntryTerminalStatus): Promise<EntryTerminalStatus> {
  const response = await apiFetch(FIRST_RUN_ENTRY_RECEIPT_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: intent }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error('入口提醒记录未保存；可以继续对话，稍后重试。');
  const value = (await response.json()) as { status?: unknown };
  if (value.status !== 'dismissed' && value.status !== 'completed') throw Error('入口提醒记录尚未确认；可以继续对话。');
  if (intent === 'completed' && value.status !== 'completed')
    throw Error('入口提醒完成记录尚未确认；可以继续对话，稍后重试。');
  return value.status;
}
