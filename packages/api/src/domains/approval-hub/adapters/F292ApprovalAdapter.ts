import type { ApprovalItem, MeetingIntake, SettledApprovalItem } from '@cat-cafe/shared';
import { meetingIntakeNeedsAttention } from '@cat-cafe/shared';
import type { MeetingIntakeStore } from '../../signal-intake/MeetingIntakeStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

const DEFAULT_SETTLED_LIMIT = 50;

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
function canonicalMeetings(intakes: readonly MeetingIntake[]): MeetingIntake[] {
  const byMeeting = new Map<string, MeetingIntake>();
  const legacyCandidates = new Map<string, MeetingIntake[]>();
  const standalone: MeetingIntake[] = [];
  for (const intake of intakes) {
    const meetingKey = explicitMeetingKey(intake);
    if (meetingKey) {
      const current = byMeeting.get(meetingKey);
      byMeeting.set(meetingKey, current ? preferredProjection(current, intake) : intake);
      continue;
    }
    const pairKey = legacyPairKey(intake);
    if (!pairKey) {
      standalone.push(intake);
      continue;
    }
    const candidates = legacyCandidates.get(pairKey) ?? [];
    candidates.push(intake);
    legacyCandidates.set(pairKey, candidates);
  }
  for (const candidates of legacyCandidates.values()) {
    const kinds = candidates.map(artifactKind);
    if (candidates.length === 2 && kinds.includes('minute') && kinds.includes('note')) {
      standalone.push(preferredProjection(candidates[0], candidates[1]));
    } else {
      standalone.push(...candidates);
    }
  }
  return [...byMeeting.values(), ...standalone];
}

function detail(intake: MeetingIntake): Record<string, unknown> {
  return {
    sourceState: intake.sourceState,
    judgmentState: intake.judgmentState,
    executionState: intake.executionState,
    healthState: intake.healthState,
    unresolved: [...intake.unresolved],
    choices: structuredClone(intake.choices),
    source: structuredClone(intake.source),
    metadata: structuredClone(intake.metadata),
    origin: structuredClone(intake.origin),
    revision: intake.revision,
    ...(intake.repair ? { repair: structuredClone(intake.repair) } : {}),
  };
}

function summary(intake: MeetingIntake): string {
  const title = typeof intake.metadata.title === 'string' ? intake.metadata.title.trim() : '';
  return title ? `整理会议：${title}` : '整理新的飞书会议记录';
}

function navigation(): ApprovalItem['navigation'] {
  return { state: 'legacy_unanchored' };
}

function toPending(intake: MeetingIntake): ApprovalItem {
  return {
    proposalId: intake.intakeId,
    sourceFeatureId: 'F292',
    requesterCatId: 'system',
    ownerUserId: intake.ownerId,
    status: 'pending',
    summary: summary(intake),
    detail: detail(intake),
    navigation: navigation(),
    inlineApprovable: false,
    decisionMode: 'meeting-intake',
    createdAt: intake.createdAt,
  };
}

function toSettled(intake: MeetingIntake): SettledApprovalItem {
  return {
    proposalId: intake.intakeId,
    sourceFeatureId: 'F292',
    requesterCatId: 'system',
    ownerUserId: intake.ownerId,
    status: intake.judgmentState === 'dismissed' ? 'rejected' : 'approved',
    summary: summary(intake),
    detail: detail(intake),
    navigation: navigation(),
    decisionMode: 'meeting-intake',
    decidedAt: intake.updatedAt,
    decidedBy: intake.ownerId,
    createdAt: intake.createdAt,
  };
}

export class F292ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F292' as const;

  constructor(private readonly store: MeetingIntakeStore) {}

  async listPending(userId: string): Promise<ApprovalItem[]> {
    return canonicalMeetings((await this.store.list()).filter((intake) => intake.ownerId === userId))
      .filter(meetingIntakeNeedsAttention)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(toPending);
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    return canonicalMeetings((await this.store.list()).filter((intake) => intake.ownerId === userId))
      .filter(
        (intake) =>
          !meetingIntakeNeedsAttention(intake) &&
          (intake.judgmentState === 'dismissed' || intake.executionState === 'succeeded'),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(toSettled);
  }
}
