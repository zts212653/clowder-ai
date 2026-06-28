import type { CatCafeConfig, RosterEntry } from '@cat-cafe/shared';

export type RuntimeBreedWithCatIds = {
  catId?: string;
  variants?: ReadonlyArray<{ catId?: string }>;
};

type BreedLike = RuntimeBreedWithCatIds & { id: string };

export function pickSeedBreed(catalog: CatCafeConfig): CatCafeConfig['breeds'][number] | undefined {
  const breeds = Array.isArray(catalog.breeds) ? catalog.breeds : [];
  if (breeds.length === 0) return undefined;

  const defaultCatId = process.env.DEFAULT_CAT_ID?.trim();
  if (defaultCatId) {
    for (const breed of breeds as BreedLike[]) {
      if (breed.catId === defaultCatId) return breed as unknown as CatCafeConfig['breeds'][number];
      if (Array.isArray(breed.variants) && breed.variants.some((v) => v.catId === defaultCatId)) {
        return breed as unknown as CatCafeConfig['breeds'][number];
      }
    }
  }
  return breeds[0];
}

function collectRuntimeCatIds(breeds: readonly RuntimeBreedWithCatIds[]): Set<string> {
  const catIds = new Set<string>();
  for (const breed of breeds) {
    if (breed.catId) catIds.add(breed.catId);
    const variants = Array.isArray(breed.variants) ? breed.variants : [];
    for (const variant of variants) {
      const catId = variant.catId !== undefined ? variant.catId : breed.catId;
      if (catId) catIds.add(catId);
    }
  }
  return catIds;
}

export function pruneRosterToRuntimeBreeds(
  roster: Record<string, RosterEntry>,
  breeds: readonly RuntimeBreedWithCatIds[],
  ownerKey: string,
  ownerEntry: RosterEntry,
): Record<string, RosterEntry> {
  const runtimeCatIds = collectRuntimeCatIds(breeds);
  const nextRoster: Record<string, RosterEntry> = {};
  for (const [catId, entry] of Object.entries(roster)) {
    if (runtimeCatIds.has(catId)) nextRoster[catId] = entry;
  }
  nextRoster[ownerKey] = ownerEntry;
  return nextRoster;
}
