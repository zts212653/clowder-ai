import type { CatConfig } from '@cat-cafe/shared';
import type { ParticipationCat } from './collective-participation-reconciler.js';

type RegisteredCat = Pick<
  CatConfig,
  'id' | 'displayName' | 'nickname' | 'variantLabel' | 'avatar' | 'roleDescription' | 'defaultModel'
>;

/** Owner-local registry projection. Eligibility is a policy check, not proof of a live model session. */
export function registeredCollectiveCats(
  cats: readonly RegisteredCat[],
  supportsParticipation: (catId: string) => boolean,
): ParticipationCat[] {
  const named = cats.map((cat) => {
    const qualifier = cat.variantLabel?.trim() || cat.nickname?.trim() || cat.defaultModel.trim();
    const displayName = cat.displayName.includes(qualifier) ? cat.displayName : `${cat.displayName}（${qualifier}）`;
    return { cat, displayName };
  });
  const counts = new Map<string, number>();
  for (const { displayName } of named) counts.set(displayName, (counts.get(displayName) ?? 0) + 1);
  return named.map(({ cat, displayName }) => ({
    id: cat.id,
    displayName: counts.get(displayName) === 1 ? displayName : `${displayName} · ${cat.id}`,
    supported: supportsParticipation(cat.id),
    avatar: cat.avatar,
    roleDescription: cat.roleDescription,
    defaultModel: cat.defaultModel,
  }));
}
