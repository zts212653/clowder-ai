import type { CatData } from '@/hooks/useCatData';
import type { SkinManifest } from '@/lib/visible-cafe/asset-config';

export function availableHomeCats(cats: CatData[]): CatData[] {
  return cats.filter((cat) => cat.roster?.available !== false);
}

export function pickSkinCat(cats: CatData[], skin: SkinManifest): CatData | null {
  const available = availableHomeCats(cats);
  const skinName = skin.displayName.toLocaleLowerCase();
  return (
    available.find((cat) =>
      [cat.nickname, cat.name, cat.displayName]
        .filter((name): name is string => Boolean(name))
        .some((name) => skinName.includes(name.toLocaleLowerCase())),
    ) ??
    available[0] ??
    null
  );
}
