import {
  type ConversationViewPreference,
  type ConversationViewPreferenceSnapshot,
  type ConversationViewPreferences,
  conversationViewPreferenceSchema,
} from '@cat-cafe/shared';
import { readUserPreferences, updateUserPreferences } from './user-preferences-store.js';

function preferenceRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resolveConversationViewPreference(
  projectRoot: string,
  threadId: string,
  participantIds: readonly string[],
): ConversationViewPreferenceSnapshot {
  const conversationViews = preferenceRecord(readUserPreferences(projectRoot).conversationViews);
  const threads = preferenceRecord(conversationViews.threads);
  const parsed = conversationViewPreferenceSchema.safeParse(threads[threadId]);
  const stored = parsed.success ? parsed.data : null;
  if (!stored) return { stored: null, effective: { mode: 'group' }, source: 'product' };
  if (stored.mode === 'cat' && !participantIds.includes(stored.catId)) {
    return { stored, effective: { mode: 'group' }, source: 'participant_missing' };
  }
  return { stored, effective: stored, source: 'thread' };
}

export function saveConversationViewPreference(
  projectRoot: string,
  threadId: string,
  participantIds: readonly string[],
  view: ConversationViewPreference,
): ConversationViewPreferenceSnapshot {
  updateUserPreferences(projectRoot, (current) => {
    const conversationViews = preferenceRecord(current.conversationViews);
    const threads = preferenceRecord(conversationViews.threads);
    const next = {
      ...conversationViews,
      threads: { ...threads, [threadId]: view },
    } as ConversationViewPreferences;
    return { ...current, conversationViews: next };
  });
  return resolveConversationViewPreference(projectRoot, threadId, participantIds);
}
