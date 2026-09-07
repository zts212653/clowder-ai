import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type { LegacyThreadAttentionGroupCommand } from '@/components/ThreadSidebar/use-attention-clusters';

export interface PreviewGroupState {
  groups: ThreadAttentionGroup[];
}

function withoutThread(groups: ThreadAttentionGroup[], threadId: string, except?: string): ThreadAttentionGroup[] {
  return groups.flatMap((group) => {
    if (group.id === except || !group.threadIds.includes(threadId)) return [group];
    const threadIds = group.threadIds.filter((id) => id !== threadId);
    return threadIds.length >= 2 ? [{ ...group, threadIds }] : [];
  });
}

function nextGroupId(groups: readonly ThreadAttentionGroup[]): string {
  const used = new Set(groups.map((group) => group.id));
  let ordinal = groups.length + 1;
  while (used.has(`attention_preview_${ordinal}`)) ordinal += 1;
  return `attention_preview_${ordinal}`;
}

/** Mirrors the production persistence command semantics while keeping this fixture owner-local. */
export function applyPreviewGroupCommand(
  state: PreviewGroupState,
  command: LegacyThreadAttentionGroupCommand,
): PreviewGroupState {
  if (command.action === 'create') {
    const threadIds = [...new Set(command.threadIds)];
    const moving = new Set(threadIds);
    const groups = state.groups.flatMap((group) => {
      const survivors = group.threadIds.filter((threadId) => !moving.has(threadId));
      return survivors.length >= 2 ? [{ ...group, threadIds: survivors }] : [];
    });
    const name = command.name?.trim().slice(0, 120);
    return {
      groups: [...groups, { id: nextGroupId(groups), ...(name ? { name } : {}), threadIds }],
    };
  }

  if (!state.groups.some((group) => group.id === command.groupId)) return state;
  if (command.action === 'move') {
    const groups = withoutThread(state.groups, command.threadId, command.groupId).map((group) => {
      if (group.id !== command.groupId) return group;
      const without = group.threadIds.filter((threadId) => threadId !== command.threadId);
      const beforeIndex = command.beforeThreadId ? without.indexOf(command.beforeThreadId) : -1;
      const threadIds =
        beforeIndex < 0
          ? [...without, command.threadId]
          : [...without.slice(0, beforeIndex), command.threadId, ...without.slice(beforeIndex)];
      return { ...group, threadIds };
    });
    return { groups };
  }

  if (command.action === 'remove') {
    const groups = state.groups.flatMap((group) => {
      if (group.id !== command.groupId) return [group];
      const threadIds = group.threadIds.filter((threadId) => threadId !== command.threadId);
      return threadIds.length >= 2 ? [{ ...group, threadIds }] : [];
    });
    return { groups };
  }

  const name = command.name?.trim().slice(0, 120) ?? '';
  return {
    groups: state.groups.map((group) => {
      if (group.id !== command.groupId) return group;
      if (name) return { ...group, name };
      const withoutName = { ...group };
      delete withoutName.name;
      return withoutName;
    }),
  };
}
