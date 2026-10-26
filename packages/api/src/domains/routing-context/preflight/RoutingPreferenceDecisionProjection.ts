import type { RoutingPreferenceRevisionV1 } from '@cat-cafe/shared';

/** Keep only the immutable head revision that can affect a routing decision. */
export function projectRoutingPreferenceHeads(
  preferences: readonly RoutingPreferenceRevisionV1[],
): RoutingPreferenceRevisionV1[] {
  const heads = new Map<string, RoutingPreferenceRevisionV1>();
  for (const preference of preferences) {
    const current = heads.get(preference.preferenceId);
    if (
      current === undefined ||
      preference.version > current.version ||
      (preference.version === current.version && preference.revisionId.localeCompare(current.revisionId) > 0)
    ) {
      heads.set(preference.preferenceId, preference);
    }
  }
  return [...heads.values()].sort((left, right) => left.preferenceId.localeCompare(right.preferenceId));
}
