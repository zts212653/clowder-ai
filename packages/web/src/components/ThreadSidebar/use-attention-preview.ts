import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AttentionListRow } from './attention-clusters';

const PREVIEW_COUNT = 4;

function previewRows(
  rows: AttentionListRow[],
  currentId: string | null,
  revealed: ReadonlySet<string>,
): AttentionListRow[] {
  const result: AttentionListRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    result.push(row);
    if (row.kind !== 'cluster-header' || !row.expanded) continue;
    const members: Extract<AttentionListRow, { kind: 'cluster-member' }>[] = [];
    let member = rows[index + 1];
    while (member?.kind === 'cluster-member') {
      members.push(member);
      index += 1;
      member = rows[index + 1];
    }
    const showAll =
      revealed.has(row.cluster.anchor) || members.slice(PREVIEW_COUNT).some((member) => member.member.id === currentId);
    const visible = showAll ? members : members.slice(0, PREVIEW_COUNT);
    result.push(...visible);
    const next = members[visible.length];
    if (next)
      result.push({
        kind: 'cluster-remainder',
        key: `remainder:${row.cluster.anchor}`,
        cluster: row.cluster,
        remainingCount: members.length - visible.length,
        nextThreadId: next.member.id,
      });
  }
  return result;
}

/** Only the open group's current reading session has a preview choice. F277 membership, sort and saved collapse stay intact. */
export function useAttentionPreview(
  lists: Record<string, AttentionListRow[]>,
  currentId: string | null,
  enabled: boolean,
) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const openAnchors = useMemo(
    () =>
      new Set(
        Object.values(lists).flatMap((rows) =>
          rows.flatMap((row) => (row.kind === 'cluster-header' && row.expanded ? [row.cluster.anchor] : [])),
        ),
      ),
    [lists],
  );
  useEffect(() => {
    setRevealed((previous) =>
      [...previous].every((anchor) => openAnchors.has(anchor))
        ? previous
        : new Set([...previous].filter((anchor) => openAnchors.has(anchor))),
    );
  }, [openAnchors]);
  const projectRows = useCallback(
    (rows: AttentionListRow[], locateId = currentId) => previewRows(rows, locateId, revealed),
    [currentId, revealed],
  );
  const visible = useMemo(
    () => (enabled ? Object.fromEntries(Object.entries(lists).map(([key, rows]) => [key, projectRows(rows)])) : lists),
    [lists, projectRows, enabled],
  );
  const reveal = useCallback((anchor: string) => setRevealed((previous) => new Set([...previous, anchor])), []);
  return { lists: visible, reveal, projectRows };
}
