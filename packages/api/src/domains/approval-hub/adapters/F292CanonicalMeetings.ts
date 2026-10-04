import type { MeetingIntake } from '@cat-cafe/shared';

export type CanonicalMeeting = { intake: MeetingIntake; aliases: readonly MeetingIntake[] };

type FeishuArtifactKind = 'minute' | 'note';

function metadataText(intake: MeetingIntake, field: string): string | null {
  const value = intake.metadata[field];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function artifactKind(intake: MeetingIntake): FeishuArtifactKind | null {
  const metadataKind = metadataText(intake, 'artifactKind');
  if (metadataKind === 'minute' || metadataKind === 'note') return metadataKind;
  const match = /^feishu:\/\/meeting-artifacts\/(minute|note)\//u.exec(intake.source.handle);
  return match?.[1] === 'minute' || match?.[1] === 'note' ? match[1] : null;
}

function explicitMeetingKey(intake: MeetingIntake): string | null {
  const meetingId = metadataText(intake, 'meetingId');
  return meetingId ? JSON.stringify(['meeting', intake.origin.pluginInstanceId, meetingId]) : null;
}

function legacyPairKey(intake: MeetingIntake): string | null {
  const kind = artifactKind(intake);
  const revision = metadataText(intake, 'revision');
  const title = metadataText(intake, 'title');
  if (kind && revision && title) {
    return JSON.stringify(['legacy-generation', intake.origin.pluginInstanceId, intake.occurredAt, revision, title]);
  }
  return null;
}

function preferredProjection(left: MeetingIntake, right: MeetingIntake): MeetingIntake {
  const rank = (intake: MeetingIntake): number => {
    const kind = artifactKind(intake);
    return kind === 'minute' ? 2 : kind === 'note' ? 1 : 0;
  };
  const rankDelta = rank(right) - rank(left);
  if (rankDelta !== 0) return rankDelta > 0 ? right : left;
  if (right.updatedAt !== left.updatedAt) return right.updatedAt > left.updatedAt ? right : left;
  return right.createdAt > left.createdAt ? right : left;
}

/** Approval Hub projects the product entity (one meeting), not transport artifacts. */
export function canonicalMeetings(intakes: readonly MeetingIntake[]): CanonicalMeeting[] {
  const byMeeting = new Map<string, MeetingIntake[]>();
  const legacyCandidates = new Map<string, MeetingIntake[]>();
  const standalone: CanonicalMeeting[] = [];
  for (const intake of intakes) {
    const meetingKey = explicitMeetingKey(intake);
    if (meetingKey) {
      const current = byMeeting.get(meetingKey);
      byMeeting.set(meetingKey, [...(current ?? []), intake]);
      continue;
    }
    const pairKey = legacyPairKey(intake);
    if (!pairKey) {
      standalone.push({ intake, aliases: [intake] });
      continue;
    }
    const candidates = legacyCandidates.get(pairKey) ?? [];
    candidates.push(intake);
    legacyCandidates.set(pairKey, candidates);
  }
  for (const candidates of legacyCandidates.values()) {
    const kinds = candidates.map(artifactKind);
    if (candidates.length === 2 && kinds.includes('minute') && kinds.includes('note')) {
      standalone.push({ intake: preferredProjection(candidates[0], candidates[1]), aliases: candidates });
    } else {
      standalone.push(...candidates.map((intake) => ({ intake, aliases: [intake] })));
    }
  }
  return [
    ...[...byMeeting.values()].map((aliases) => ({ intake: aliases.reduce(preferredProjection), aliases })),
    ...standalone,
  ];
}
