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
  outsideWorkingOrder: string[];
}

export function attentionItemKey(item: AttentionRenderItem): string {
  return item.kind === 'thread' ? `thread:${item.thread.id}` : item.cluster.anchor;
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Retain order metadata only; rendered facts always come from the current Sidebar snapshot. */
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
      prior && prior.mode === mode && sameSequence(prior.sourceIds, sourceIds)
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

  // Reading a Group must not freeze unrelated work. Only retain its placement while
  // working-order inputs outside open Groups are unchanged. Stable IDs alone miss a
  // refined start time or a different working member of the same closed Group.
  // These signatures release the hold; canonical sorting stays upstream.
  const outsideWorkingOrder = ordered.flatMap((item) => {
    if (item.kind === 'cluster' && openGroups[item.cluster.anchor]) return [];
    const working = (item.kind === 'thread' ? [item.thread] : item.members).filter(
      (member) => member.presence.status === 'working',
    );
    if (working.length === 0) return [];
    return [
      JSON.stringify([
        attentionItemKey(item),
        working.map((member) => [member.id, member.pinned, member.presence.activeSince ?? Number.MAX_SAFE_INTEGER]),
      ]),
    ];
  });
  const keepPlacement =
    previous &&
    Object.keys(openGroups).some((anchor) => previous.openGroups[anchor]) &&
    sameSequence(previous.outsideWorkingOrder, outsideWorkingOrder);
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
    snapshot: { itemKeys, openGroups, outsideWorkingOrder },
  };
}
