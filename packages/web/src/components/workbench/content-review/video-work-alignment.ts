import type { WorkVideoContext } from '@cat-cafe/shared';

type Story = WorkVideoContext['story'][number];

/** Source IDs are explicit lineage, while paragraph IDs, text and seconds are not. */
export function matchVideoStory(left: Story[], right: Story[]) {
  const unique = (rows: Story[]) => {
    const result = new Map<string, Story | null>();
    for (const row of rows) {
      if (!row.sourceId) continue;
      result.set(row.sourceId, result.has(row.sourceId) ? null : row);
    }
    return result;
  };
  const leftBySource = unique(left),
    rightBySource = unique(right);
  return [...rightBySource].flatMap(([sourceId, rightRow]) => {
    const leftRow = leftBySource.get(sourceId);
    return leftRow && rightRow ? [{ sourceId, left: leftRow, right: rightRow }] : [];
  });
}

/** Chapter IDs carry the same explicit lineage requirement as sentence IDs. */
export const matchVideoChapters = matchVideoStory;
