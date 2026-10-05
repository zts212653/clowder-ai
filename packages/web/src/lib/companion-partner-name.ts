import { type CatDisplayNameData, formatCatDisplayName, resolveCatDisplayName } from './cat-display-name';

type PartnerCat = CatDisplayNameData & { nickname?: string };

/** The companion speaks to a named partner; the roster's breed label stays the fallback. */
export function resolveCompanionPartnerName(catId: string, getCatById: (id: string) => PartnerCat | undefined): string {
  const nickname = getCatById(catId)?.nickname?.trim();
  return nickname || resolveCatDisplayName(catId, getCatById);
}

/** Keep variants distinct in the explicit chooser while speaking to the cat by name. */
export function formatCompanionPartnerChoice(cat: PartnerCat): string {
  const nickname = cat.nickname?.trim();
  if (!nickname) return formatCatDisplayName(cat);
  return cat.variantLabel ? `${nickname}（${cat.variantLabel}）` : nickname;
}
