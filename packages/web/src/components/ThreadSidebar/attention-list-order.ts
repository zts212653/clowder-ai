import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import type { AttentionCluster, AttentionRenderItem } from './attention-clusters';

interface OpenMemberOrder {
  mode: ThreadAttentionMemberSort;
  sourceIds: string[];
  ids: string[];
}

export interface AttentionOrderSnapshot {
  itemKeys: string[];
  openGroups: Record<string, OpenMemberOrder>;
}

export function attentionItemKey(item: AttentionRenderItem): string {
  return item.kind === 'thread' ? `thread:${item.thread.id}` : item.cluster.anchor;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Cache identities only: every rendered fact still comes from the current Sidebar snapshot. */
export function orderAttentionList(
  items: readonly AttentionRenderItem[],
  isOpen: (cluster: AttentionCluster) => boolean,
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  previous?: AttentionOrderSnapshot,
): { items: AttentionRenderItem[]; snapshot: AttentionOrderSnapshot } {
  const openGroups: AttentionOrderSnapshot['openGroups'] = {};
  const ordered = items.map((item): AttentionRenderItem => {
    if (item.kind === 'thread' || !isOpen(item.cluster)) return item;
    const anchor = item.cluster.anchor;
    const mode = modes[anchor] ?? 'manual';
    const sourceIds = item.members.map((member) => member.id);
    const prior = previous?.openGroups[anchor];
    const members = new Map(item.members.map((member) => [member.id, member]));
    const ids =
      prior && prior.mode === mode && sameIds(prior.sourceIds, sourceIds)
        ? prior.ids
        : mode === 'running-first'
          ? [
              ...item.members.filter((member) => member.presence.status === 'working'),
              ...item.members.filter((member) => member.presence.status !== 'working'),
            ].map((member) => member.id)
          : sourceIds;
    openGroups[anchor] = { mode, sourceIds, ids };
    return {
      ...item,
      members: ids.flatMap((id) => {
        const member = members.get(id);
        return member ? [member] : [];
      }),
    };
  });

  // Keep the surrounding list stable for an ongoing reading session too. Closing all Groups
  // releases the hold. Removed rows disappear; new rows join after existing visible rows.
  const keepPlacement = previous && Object.keys(openGroups).some((anchor) => previous.openGroups[anchor]);
  const byKey = new Map(ordered.map((item) => [attentionItemKey(item), item]));
  const currentKeys = ordered.map(attentionItemKey);
  const priorKeys = new Set(previous?.itemKeys);
  const itemKeys = keepPlacement
    ? [...previous.itemKeys.filter((key) => byKey.has(key)), ...currentKeys.filter((key) => !priorKeys.has(key))]
    : currentKeys;
  return {
    items: itemKeys.flatMap((key) => {
      const item = byKey.get(key);
      return item ? [item] : [];
    }),
    snapshot: { itemKeys, openGroups },
  };
}
