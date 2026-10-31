import { useShellPresentation } from '@/components/shell/shell-presentation';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar } from '@/lib/cat-slug';
import { UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';
import { tintOf } from '@/lib/hex-color';
import type { DirectionInfo } from '@/lib/parse-direction';

interface DirectionPillProps {
  direction: DirectionInfo;
  getCatById: (id: string) => CatData | undefined;
}

/**
 * F098: Direction pill badge — shows "→ @猫名" in breed color.
 * Placed in ChatMessage header row, after timestamp.
 *
 * F322 B: in the new shell the words are written in the cat's readable name role (`--color-{cat}-text`, the token the message
 * name and the reply pill use), not in its identity hex; the 12.5% tint behind them stays the identity colour, because it says
 * who. A target with no cat behind it (an id the catalogue does not know, a cross-thread pointer) is not a cat, so it carries no
 * cat colour at all (DESIGN.md: colour is spent on who): the body text role on the neutral surface-3 base; its arrow stays, and
 * for a cross-thread pointer the arrow is the sign that it is one. Classic keeps the fallback hex (frozen).
 */
export function DirectionPill({ direction, getCatById }: DirectionPillProps) {
  const v2 = useShellPresentation() === 'v2';
  const labels = direction.targets.map((target) => {
    if (direction.type === 'crossPost') return target;
    const cat = getCatById(target);
    return cat ? `@${formatCatDisplayName(cat)}` : `@${target}`;
  });
  const text = `${direction.arrow} ${labels.join(' + ')}`;

  // Breed color from first target cat (fallback to ragdoll purple)
  const firstCat = direction.type !== 'crossPost' ? getCatById(direction.targets[0]) : undefined;
  const color = firstCat?.color.primary ?? UNKNOWN_CAT_COLOR.primary;

  const style =
    v2 && !firstCat
      ? { backgroundColor: 'var(--shell-selected)', color: 'var(--shell-body)' }
      : { backgroundColor: tintOf(color, '20'), color: v2 ? catColorVar(firstCat?.id, 'text') : color };

  return (
    <span className="text-micro font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap" style={style}>
      {text}
    </span>
  );
}
