import type { CollectiveMemberDirectory, CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { MemberAvatar } from './MemberAvatar.js';

export function HumanIdentityChip({
  humanId,
  humans,
  fallbackName,
  suffix,
}: {
  readonly humanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly fallbackName: string;
  readonly suffix?: string;
}) {
  const human = humans.find((candidate) => candidate.humanId === humanId);
  const name = human?.displayName ?? fallbackName;
  return (
    <span className="project-identity-chip" data-identity-kind="human">
      <MemberAvatar name={name} kind="human" avatarUrl={human?.avatarUrl} compact />
      <span>{name}</span>
      {suffix && <small>{suffix}</small>}
    </span>
  );
}

export function AgentIdentityChip({
  assignment,
  participants,
  suffix,
}: {
  readonly assignment: NonNullable<CollectiveWorkProjection['assignment']>;
  readonly participants: readonly CollectiveParticipant[];
  readonly suffix?: string;
}) {
  const participant = participants.find(
    (candidate) =>
      candidate.connectionId === assignment.connectionId &&
      candidate.catId === assignment.catId &&
      candidate.humanId === assignment.humanId,
  );
  return (
    <span className="project-identity-chip" data-identity-kind="agent">
      <MemberAvatar
        name={participant?.displayLabel ?? assignment.displayName}
        kind="agent"
        avatarUrl={participant?.avatarDataUrl}
        compact
      />
      <span>{participant?.displayLabel ?? assignment.displayName}</span>
      {suffix && <small>{suffix}</small>}
    </span>
  );
}

export function WorkIdentityChips({
  work,
  humans,
  participants,
  humanNames,
}: {
  readonly work: CollectiveWorkProjection;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
}) {
  return (
    <span className="project-work-identities">
      {work.accountableHumanId ? (
        <HumanIdentityChip
          humanId={work.accountableHumanId}
          humans={humans}
          fallbackName={humanNames[work.accountableHumanId] ?? '共同体成员'}
          suffix="负责"
        />
      ) : (
        <span className="project-identity-empty">未分配</span>
      )}
      {work.assignment && <AgentIdentityChip assignment={work.assignment} participants={participants} suffix="执行" />}
    </span>
  );
}
