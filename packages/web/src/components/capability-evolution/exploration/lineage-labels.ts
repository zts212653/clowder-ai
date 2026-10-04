import type { layoutExplorationLineage } from './exploration-lineage';
import type { ExplorationReading } from './exploration-reading';

type Box = { left: number; top: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width + 4 &&
  a.left + a.width + 4 > b.left &&
  a.top < b.top + b.height + 4 &&
  a.top + a.height + 4 > b.top;

/** Labels compete for screen space, with the selected version first; source order breaks ties. */
export function lineageLabels(
  layout: ReturnType<typeof layoutExplorationLineage>,
  view: ExplorationReading['viewport'],
  size: { width: number; height: number },
  selected?: string,
) {
  const result = new Map<string, { side: 'start' | 'end'; above: boolean }>();
  const occupied: Box[] = [];
  const ordered = [...layout.nodes].sort((a, b) => Number(b.key === selected) - Number(a.key === selected));
  for (const item of ordered) {
    const x = (item.x + 88) * view.zoom + view.x;
    const y = (item.y + 56) * view.zoom + view.y;
    const width = Math.min(
      170,
      [...item.node.title].reduce((sum, ch) => sum + (/[^\x00-\x7f]/.test(ch) ? 12 : 7), 8),
    );
    const side = x + width > size.width ? 'end' : 'start';
    const above = y + 32 > size.height;
    const box = { left: side === 'end' ? x + 14 - width : x - 14, top: above ? y - 30 : y + 14, width, height: 18 };
    if (
      box.left < 0 ||
      box.top < 0 ||
      box.left + width > size.width ||
      box.top + box.height > size.height ||
      occupied.some((prior) => overlaps(prior, box))
    )
      continue;
    occupied.push(box);
    result.set(item.key, { side, above });
  }
  return result;
}
