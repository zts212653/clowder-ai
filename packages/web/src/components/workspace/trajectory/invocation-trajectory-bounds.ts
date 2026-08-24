import type { InvocationTimelineRow } from './invocation-trajectory-model';

function isAnomaly(row: InvocationTimelineRow): boolean {
  return row.kind === 'error' || (row.kind === 'tool' && row.resultStatus === 'error');
}

function overflowType(row: InvocationTimelineRow): string {
  if (row.kind === 'message') return row.role.toUpperCase();
  if (row.kind === 'status-group') return 'STATUS';
  if (row.kind === 'session') return 'CONTEXT';
  if (row.kind === 'terminal' || row.kind === 'system') return 'SYSTEM';
  return row.kind.toUpperCase();
}

function countOverflowTypes(rows: readonly InvocationTimelineRow[]): Record<string, number> {
  const types: Record<string, number> = {};
  for (const row of rows) {
    const type = overflowType(row);
    types[type] = (types[type] ?? 0) + 1;
  }
  return types;
}

function projectedRowCount(selected: ReadonlySet<number>, rowCount: number): number {
  let gaps = 0;
  let insideGap = false;
  for (let index = 0; index < rowCount; index += 1) {
    if (selected.has(index)) insideGap = false;
    else if (!insideGap) {
      gaps += 1;
      insideGap = true;
    }
  }
  return selected.size + gaps;
}

/** Preserve causal opening, terminal tail, and every anomaly; fold only the gaps between them. */
export function boundTimelineRows(rows: InvocationTimelineRow[], maxVisibleRows: number) {
  const safeLimit = Math.max(1, maxVisibleRows);
  if (rows.length <= safeLimit) return { hiddenRowCount: 0, visibleRows: rows };
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(6, rows.length); index += 1) selected.add(index);
  for (let index = Math.max(0, rows.length - 4); index < rows.length; index += 1) selected.add(index);
  rows.forEach((row, index) => {
    if (isAnomaly(row)) selected.add(index);
  });
  if (projectedRowCount(selected, rows.length) <= safeLimit) {
    for (let index = 0; index < rows.length; index += 1) {
      if (selected.has(index)) continue;
      selected.add(index);
      if (projectedRowCount(selected, rows.length) > safeLimit) selected.delete(index);
    }
  }

  const visibleRows: InvocationTimelineRow[] = [];
  let hiddenRowCount = 0;
  let index = 0;
  while (index < rows.length) {
    if (selected.has(index)) {
      visibleRows.push(rows[index]!);
      index += 1;
      continue;
    }
    const start = index;
    while (index < rows.length && !selected.has(index)) index += 1;
    const hidden = rows.slice(start, index);
    hiddenRowCount += hidden.length;
    visibleRows.push({
      id: `overflow-${start}-${index - 1}`,
      kind: 'overflow',
      timestamp: hidden[0]?.timestamp ?? 0,
      count: hidden.length,
      types: countOverflowTypes(hidden),
    });
  }
  return { hiddenRowCount, visibleRows };
}
