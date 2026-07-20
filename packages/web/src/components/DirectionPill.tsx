import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import type { DirectionInfo } from '@/lib/parse-direction';

interface DirectionPillProps {
  direction: DirectionInfo;
  getCatById: (id: string) => CatData | undefined;
}

/**
 * F098: Direction pill badge — shows "→ @猫名" in breed color.
 * Placed in ChatMessage header row, after timestamp.
 */
export function DirectionPill({ direction, getCatById }: DirectionPillProps) {
  const labels = direction.targets.map((target) => {
    if (direction.type === 'crossPost') return target;
    const cat = getCatById(target);
    return cat ? `@${formatCatDisplayName(cat)}` : `@${target}`;
  });
  const text = `${direction.arrow} ${labels.join(' + ')}`;

  // Breed color from first target cat (fallback to ragdoll purple)
  const firstCat = direction.type !== 'crossPost' ? getCatById(direction.targets[0]) : undefined;
  const color = firstCat?.color.primary ?? UNKNOWN_CAT_COLOR.primary;

  return (
    <span
      className="text-micro font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap"
      style={{ backgroundColor: `${color}20`, color }}
    >
      {text}
    </span>
  );
}
