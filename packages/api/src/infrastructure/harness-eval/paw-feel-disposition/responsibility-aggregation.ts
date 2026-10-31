import type { PawFeelResponsibilityProjection } from '@cat-cafe/shared';

const RESPONSIBILITY_PRIORITY: Record<PawFeelResponsibilityProjection['state'], number> = {
  unreviewed: 0,
  blocked: 1,
  signature_waiting: 2,
  bound_in_repair: 3,
  terminal: 4,
};

export function aggregatePawFeelResponsibility(
  responsibilities: readonly PawFeelResponsibilityProjection[],
  emptyErrorMessage = 'paw-feel responsibility group has no members',
): PawFeelResponsibilityProjection {
  const representative = [...responsibilities].sort(
    (left, right) =>
      Number(left.validExit) - Number(right.validExit) ||
      RESPONSIBILITY_PRIORITY[left.state] - RESPONSIBILITY_PRIORITY[right.state],
  )[0];
  if (!representative) throw new Error(emptyErrorMessage);
  const sameState = responsibilities.filter((entry) => entry.state === representative.state);
  return {
    ...representative,
    validExit: responsibilities.every((entry) => entry.validExit),
    evidenceRefs: [...new Set(sameState.flatMap((entry) => entry.evidenceRefs))],
  };
}
