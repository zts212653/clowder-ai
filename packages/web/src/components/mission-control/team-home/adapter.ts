import type { BacklogItem, CatId, ThreadPhase } from '@cat-cafe/shared';
import { teamHomeFixture } from './fixture';
import type { TeamHomeData, TeamHomeMissionSummary, TeamHomeParticipantId, TeamHomeSOPStage } from './types';

export interface TeamHomeAdapterInput {
  items: BacklogItem[];
  threadsByBacklogId?: Record<string, { lastActiveAt: number; participants: CatId[] }>;
}

function mapThreadPhaseToSOP(phase: ThreadPhase | undefined): TeamHomeSOPStage {
  switch (phase) {
    case 'coding':
      return 'impl';
    case 'research':
    case 'brainstorm':
      return 'kickoff';
    default:
      return 'impl';
  }
}

function inferSOPStage(item: BacklogItem): TeamHomeSOPStage {
  const leaseState = item.lease?.state;
  if (leaseState === 'active') return mapThreadPhaseToSOP(item.dispatchedThreadPhase);

  switch (item.status) {
    case 'suggested':
    case 'approved':
      return 'kickoff';
    case 'dispatched':
      return mapThreadPhaseToSOP(item.dispatchedThreadPhase);
    case 'done':
      return 'completion';
    default:
      return 'kickoff';
  }
}

function inferOwner(item: BacklogItem): TeamHomeParticipantId {
  if (item.lease?.state === 'active' && item.lease.ownerCatId) {
    return item.lease.ownerCatId;
  }
  if (item.suggestion?.catId) {
    return item.suggestion.catId;
  }
  return 'kiimi' as CatId;
}

function inferNextAction(item: BacklogItem): string {
  const stage = inferSOPStage(item);
  const owner = inferOwner(item);
  switch (stage) {
    case 'kickoff':
      return `等待 @${owner} 领取或进入 kickoff`;
    case 'impl':
      return `@${owner} 正在实现中`;
    case 'quality_gate':
      return `@${owner} 自检中，等待 quality gate 通过`;
    case 'review':
      return `@${owner} 完成后进入 cross-cat review`;
    case 'merge':
      return '等待 merge gate 与最终合入';
    case 'completion':
      return '已完成';
    default:
      return '等待下一步动作';
  }
}

function extractFeatureIdFromTags(tags: readonly string[]): string | undefined {
  const featureTag = tags.find((tag) => /^F\d+$/i.test(tag));
  return featureTag ? featureTag.toUpperCase() : undefined;
}

function deriveMissionFromItems(
  items: BacklogItem[],
): Pick<TeamHomeData['mission'], 'phase' | 'activeFeatureId' | 'truthSourceUrl'> {
  if (items.length === 0) {
    return { phase: 'kickoff', activeFeatureId: '—' };
  }

  const dispatched = items.find((i) => i.status === 'dispatched');
  const candidate = dispatched ?? items.find((i) => i.status === 'approved') ?? items[0];
  const featureId = extractFeatureIdFromTags(candidate?.tags ?? []);

  return {
    phase: inferSOPStage(candidate),
    activeFeatureId: candidate?.id ?? '—',
    truthSourceUrl: featureId ? `/docs/features/${featureId}.md` : undefined,
  };
}

export function adaptTeamHomeData(input: TeamHomeAdapterInput): TeamHomeData {
  const { items } = input;

  const activeStatuses = new Set<BacklogItem['status']>(['approved', 'dispatched']);

  const missions: TeamHomeMissionSummary[] = items
    .filter((item) => activeStatuses.has(item.status))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      name: item.title,
      owner: inferOwner(item),
      stage: inferSOPStage(item),
      evidenceCount: item.audit?.length ?? 0,
      requiredEvidence: 4,
      nextAction: inferNextAction(item),
      updatedAt: new Date(item.updatedAt).toISOString(),
    }));

  const missionOverride = deriveMissionFromItems(items);

  return {
    ...teamHomeFixture,
    mission: {
      ...teamHomeFixture.mission,
      ...missionOverride,
    },
    missions,
  };
}
