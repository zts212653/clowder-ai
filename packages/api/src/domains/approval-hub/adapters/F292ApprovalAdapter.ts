import type { ApprovalItem, MeetingIntake, SettledApprovalItem } from '@cat-cafe/shared';
import { meetingIntakeNeedsAttention } from '@cat-cafe/shared';
import type { MeetingIntakeStore } from '../../signal-intake/MeetingIntakeStore.js';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';

const DEFAULT_SETTLED_LIMIT = 50;

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
    return (await this.store.list())
      .filter((intake) => intake.ownerId === userId && meetingIntakeNeedsAttention(intake))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(toPending);
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    return (await this.store.list())
      .filter(
        (intake) =>
          intake.ownerId === userId &&
          !meetingIntakeNeedsAttention(intake) &&
          (intake.judgmentState === 'dismissed' || intake.executionState === 'succeeded'),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(toSettled);
  }
}
