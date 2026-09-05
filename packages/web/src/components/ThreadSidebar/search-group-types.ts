import type { ThreadAttentionGroup } from '@cat-cafe/shared';

interface Membership {
  v: 1;
  groupId: string;
  order: number;
}
export interface GroupUndoEntry {
  threadId: string;
  before: Membership | null;
  after: Membership | null;
}
export interface GroupUndoReceipt {
  entries: GroupUndoEntry[];
  proof: string;
}
export interface GroupSnapshot {
  id: string;
  threadIds: string[];
}
export interface ThreadAttentionPreferences {
  aliases: Record<string, string>;
  open: Record<string, boolean>;
  groups: ThreadAttentionGroup[];
  undo?: GroupUndoReceipt;
}
export type GroupMutationResult =
  | { ok: true; preferences: ThreadAttentionPreferences }
  | { ok: false; error: string; conflict: boolean };
export interface SearchGroupRequest {
  query: string;
  threadId?: string;
  groupId?: string;
}

export function groupTitle(group: ThreadAttentionGroup): string {
  return group.name?.trim() || `${group.threadIds.length} 个对话`;
}
