import type { ThreadAttentionPreferences } from '@cat-cafe/shared';
import { readUserPreferences, updateUserPreferences } from './user-preferences-store.js';

const GROUP_ID_RE = /^attention_[A-Za-z0-9_-]+$/;
const THREAD_ID_RE = /^thread_[A-Za-z0-9_-]+$/;

function sanitizePreferences(value: unknown): Required<ThreadAttentionPreferences> {
  if (typeof value !== 'object' || value === null) return { aliases: {}, open: {} };
  const candidate = value as ThreadAttentionPreferences;
  const aliases = Object.fromEntries(
    Object.entries(candidate.aliases ?? {}).filter(
      (entry): entry is [string, string] =>
        isStableThreadAttentionAnchor(entry[0]) && typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  );
  const open = Object.fromEntries(
    Object.entries(candidate.open ?? {}).filter(
      (entry): entry is [string, boolean] => isStableThreadAttentionAnchor(entry[0]) && typeof entry[1] === 'boolean',
    ),
  );
  return { aliases, open };
}

export function isStableThreadAttentionAnchor(anchor: string): boolean {
  return /^group:attention_[A-Za-z0-9_-]+$/.test(anchor);
}

export function isStableThreadAttentionGroupId(groupId: string): boolean {
  return GROUP_ID_RE.test(groupId);
}

export function isStableThreadAttentionThreadId(threadId: string): boolean {
  return THREAD_ID_RE.test(threadId);
}

export function resolveThreadAttentionPreferences(projectRoot: string): Required<ThreadAttentionPreferences> {
  return sanitizePreferences(readUserPreferences(projectRoot).threadAttention);
}

export function saveThreadAttentionPreference(
  projectRoot: string,
  input: { anchor: string; alias?: string | null; open?: boolean | null },
): Required<ThreadAttentionPreferences> {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizePreferences(current.threadAttention);
    const aliases = { ...existing.aliases };
    const open = { ...existing.open };
    if (input.alias !== undefined) {
      if (input.alias === null) delete aliases[input.anchor];
      else aliases[input.anchor] = input.alias.trim();
    }
    if (input.open !== undefined) {
      if (input.open === null) delete open[input.anchor];
      else open[input.anchor] = input.open;
    }
    return { ...current, threadAttention: { aliases, open } };
  });
  return resolveThreadAttentionPreferences(projectRoot);
}
