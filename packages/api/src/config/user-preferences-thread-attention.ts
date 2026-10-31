import type { ThreadAttentionMemberSort, ThreadAttentionPreferences } from '@cat-cafe/shared';
import { readUserPreferences, updateUserPreferences } from './user-preferences-store.js';

const GROUP_ID_RE = /^attention_[A-Za-z0-9_-]+$/;
const THREAD_ID_RE = /^thread_[A-Za-z0-9_-]+$/;

type ResolvedPreferences = ThreadAttentionPreferences & {
  aliases: Record<string, string>;
  open: Record<string, boolean>;
};

function sanitizePreferences(value: unknown): ResolvedPreferences {
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
  const memberSort = Object.fromEntries(
    Object.entries(candidate.memberSort ?? {}).filter(
      (entry): entry is [string, ThreadAttentionMemberSort] =>
        isStableThreadAttentionAnchor(entry[0]) && (entry[1] === 'manual' || entry[1] === 'running-first'),
    ),
  );
  const collapsedPeek = Object.fromEntries(
    Object.entries(candidate.collapsedPeek ?? {}).filter(
      (entry): entry is [string, boolean] => isStableThreadAttentionAnchor(entry[0]) && typeof entry[1] === 'boolean',
    ),
  );
  return {
    aliases,
    open,
    ...(Array.isArray(candidate.recentGroupIds)
      ? {
          recentGroupIds: [
            ...new Set(candidate.recentGroupIds.filter((id) => typeof id === 'string' && GROUP_ID_RE.test(id))),
          ],
        }
      : {}),
    ...(Object.keys(memberSort).length ? { memberSort } : {}),
    ...(Object.keys(collapsedPeek).length ? { collapsedPeek } : {}),
  };
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

export function resolveThreadAttentionPreferences(projectRoot: string): ResolvedPreferences {
  return sanitizePreferences(readUserPreferences(projectRoot).threadAttention);
}

export function saveThreadAttentionPreference(
  projectRoot: string,
  input: {
    anchor: string;
    alias?: string | null;
    open?: boolean | null;
    collapsedPeek?: boolean | null;
    memberSort?: ThreadAttentionMemberSort | null;
  },
): ResolvedPreferences {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizePreferences(current.threadAttention);
    const aliases = { ...existing.aliases };
    const open = { ...existing.open };
    const memberSort = { ...existing.memberSort };
    const collapsedPeek = { ...existing.collapsedPeek };
    if (input.alias !== undefined) {
      if (input.alias === null) delete aliases[input.anchor];
      else aliases[input.anchor] = input.alias.trim();
    }
    if (input.open !== undefined) {
      if (input.open === null) delete open[input.anchor];
      else open[input.anchor] = input.open;
    }
    if (input.memberSort !== undefined) {
      if (input.memberSort === null) delete memberSort[input.anchor];
      else memberSort[input.anchor] = input.memberSort;
    }
    if (input.collapsedPeek !== undefined) {
      if (input.collapsedPeek === null) delete collapsedPeek[input.anchor];
      else collapsedPeek[input.anchor] = input.collapsedPeek;
    }
    return {
      ...current,
      threadAttention: {
        ...(existing.recentGroupIds ? { recentGroupIds: existing.recentGroupIds } : {}),
        aliases,
        open,
        ...(Object.keys(memberSort).length ? { memberSort } : {}),
        ...(Object.keys(collapsedPeek).length ? { collapsedPeek } : {}),
      },
    };
  });
  return resolveThreadAttentionPreferences(projectRoot);
}

export function recordRecentThreadAttentionGroup(projectRoot: string, groupId: string): void {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizePreferences(current.threadAttention);
    return {
      ...current,
      threadAttention: {
        ...existing,
        recentGroupIds: [groupId, ...(existing.recentGroupIds ?? []).filter((id) => id !== groupId)],
      },
    };
  });
}
