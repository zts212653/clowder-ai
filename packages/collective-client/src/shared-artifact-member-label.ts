import type { CollectiveMemberDirectory } from '@cat-cafe/shared';

type Human = { humanId: string; displayName: string };
type Cafe = Pick<CollectiveMemberDirectory['cafes'][number], 'humanId' | 'connectionId' | 'endpointLabel'>;

/** Use the existing public member directory; authority remains on the management read and offer transaction. */
export function artifactMemberLabel(human: Human, directory?: CollectiveMemberDirectory) {
  const namesakes = directory?.humans.filter((member) => member.displayName === human.displayName) ?? [];
  if (namesakes.length < 2) return human.displayName;
  const cafes = (humanId: string) =>
    [...new Set(directory?.cafes.filter((cafe) => cafe.humanId === humanId).map((cafe) => cafe.endpointLabel))]
      .sort()
      .join('、');
  const qualifier = cafes(human.humanId);
  const ambiguous =
    !qualifier || namesakes.some((member) => member.humanId !== human.humanId && cafes(member.humanId) === qualifier);
  return `${human.displayName} · ${qualifier ? `${qualifier}${ambiguous ? ' · ' : ''}` : ''}${ambiguous ? human.humanId : ''}`;
}

export function artifactCafeLabel(cafe: Cafe, directory: CollectiveMemberDirectory) {
  const human = directory.humans.find((member) => member.humanId === cafe.humanId);
  const label = human ? artifactMemberLabel(human, directory) : cafe.humanId;
  const duplicated = directory.cafes.some(
    (other) =>
      other.connectionId !== cafe.connectionId &&
      other.humanId === cafe.humanId &&
      other.endpointLabel === cafe.endpointLabel,
  );
  return `${label} · ${cafe.endpointLabel}${duplicated ? `（${cafe.connectionId}）` : ''}`;
}
