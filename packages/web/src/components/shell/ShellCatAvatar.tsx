'use client';

import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { CatAvatar } from '../CatAvatar';
import { PawIcon } from '../icons/PawIcon';

/** Name used when the registry does not know a cat: the shell says "Clowder AI", never the internal id. */
export const UNKNOWN_CAT_NAME = '猫猫';

type GetCatById = ReturnType<typeof useCatData>['getCatById'];

/**
 * A cat's human-facing name for shell surfaces, or null when the registry does not know the cat.
 * `resolveCatDisplayName` deliberately falls back to the raw id for diagnostics; shell copy must not.
 */
export function knownCatName(catId: string, getCatById: GetCatById): string | null {
  return getCatById(catId) ? resolveCatDisplayName(catId, getCatById) : null;
}

/** Avatar for shell surfaces. Unknown cats get a neutral paw with NO alt text (CatAvatar's alt would be the raw id). */
export function ShellCatAvatar({ catId, size }: { catId: string; size: number }) {
  const { getCatById } = useCatData();
  if (getCatById(catId)) return <CatAvatar catId={catId} size={size} />;
  return (
    <span
      aria-hidden="true"
      className="inline-flex flex-none items-center justify-center overflow-hidden rounded-full"
      style={{ width: size, height: size, background: 'var(--shell-selected)', color: 'var(--shell-muted)' }}
    >
      <PawIcon className="text-micro" />
    </span>
  );
}
