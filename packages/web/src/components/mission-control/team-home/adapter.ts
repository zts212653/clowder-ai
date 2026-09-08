import type { BacklogItem, CatId, ThreadPhase } from '@cat-cafe/shared';
import { teamHomeFixture } from './fixture';
import type { TeamHomeData, TeamHomeMissionSummary, TeamHomeParticipantId, TeamHomeSOPStage } from './types';

interface TeamHomeThreadSummary {
  lastActiveAt: number;
  participants: CatId[];
}

interface TeamMemberUpdate {
  currentContext: string;
  lastActiveAt: number;
  priority: number;
}

export interface TeamHomeAdapterInput {
  items: BacklogItem[];
  threadsByBacklogId?: Record<string, TeamHomeThreadSummary>;
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

const MAX_VISIBLE_MISSIONS = 8;

function inferNextAction(item: BacklogItem): string {
  const stage = inferSOPStage(item);
  const owner = inferOwner(item);
  switch (stage) {
    case 'kickoff':
      return `等待 @${owner} 领取或进入 kickoff`;
    case 'impl':
      return `@${owner} 正在实现中`;
    case 'completion':
      return '已完成';
    default:
      return '等待下一步动作';
  }
}

function normalizeFeatureId(raw: string): string | undefined {
  const match = raw.match(/^f0*(\d+)$/i);
  return match ? `F${match[1].padStart(3, '0')}` : undefined;
}

function extractFeatureIdFromTags(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const prefixed = tag.match(/^feature:(f\d+)$/i);
    if (prefixed) return normalizeFeatureId(prefixed[1]);
    if (/^F\d+$/i.test(tag)) return normalizeFeatureId(tag);
  }
  return undefined;
}

function isActiveMissionItem(item: BacklogItem): boolean {
  return item.status === 'approved' || item.status === 'dispatched';
}

function pickActiveItem(items: BacklogItem[]): BacklogItem | undefined {
  const activeItems = items.filter(isActiveMissionItem);
  return (
    activeItems.find((item) => item.lease?.state === 'active') ??
    activeItems.find((item) => item.status === 'dispatched') ??
    activeItems.find((item) => item.status === 'approved')
  );
}

function deriveMissionFromItem(
  item: BacklogItem | undefined,
): Pick<TeamHomeData['mission'], 'phase' | 'activeFeatureId' | 'truthSourceUrl'> {
  if (!item) {
    return { phase: 'kickoff', activeFeatureId: '—' };
  }

  const featureId = extractFeatureIdFromTags(item.tags);

  return {
    phase: inferSOPStage(item),
    activeFeatureId: featureId ?? item.id,
    truthSourceUrl: featureId
      ? `/api/backlog/feature-doc-detail?featureId=${encodeURIComponent(featureId)}`
      : undefined,
  };
}

function deriveBatonFromItem(item: BacklogItem | undefined): TeamHomeData['baton'] {
  if (!item) return teamHomeFixture.baton;

  const holder = inferOwner(item);
  const since = item.lease?.state === 'active' ? item.lease.acquiredAt : (item.dispatchedAt ?? item.updatedAt);
  return {
    ...teamHomeFixture.baton,
    holder,
    scope: item.title,
    since: new Date(since).toISOString(),
    nextStep: inferNextAction(item),
    nextOwner: undefined,
    blocker: null,
  };
}

function shouldReplaceTeamUpdate(existing: TeamMemberUpdate | undefined, next: TeamMemberUpdate): boolean {
  return (
    !existing ||
    next.priority > existing.priority ||
    (next.priority === existing.priority && next.lastActiveAt > existing.lastActiveAt)
  );
}

function setTeamUpdate(
  updates: Map<string, TeamMemberUpdate>,
  id: TeamHomeParticipantId,
  currentContext: string,
  lastActiveAt: number,
  priority: number,
): void {
  const next = { currentContext, lastActiveAt, priority };
  if (shouldReplaceTeamUpdate(updates.get(id), next)) {
    updates.set(id, next);
  }
}

function isVisibleTeamItem(item: BacklogItem): boolean {
  return item.status === 'approved' || item.status === 'dispatched';
}

function ownerContextPrefix(item: BacklogItem): string {
  if (item.lease?.state === 'active') return '持球';
  if (item.status === 'dispatched') return '执行';
  return '待派发';
}

function addItemTeamUpdates(
  updates: Map<string, TeamMemberUpdate>,
  item: BacklogItem,
  thread: TeamHomeThreadSummary | undefined,
): void {
  const owner = inferOwner(item);
  const ownerTimestamp = thread?.lastActiveAt ?? item.lease?.heartbeatAt ?? item.updatedAt;
  setTeamUpdate(updates, owner, `${ownerContextPrefix(item)}：${item.title}`, ownerTimestamp, 2);

  if (!thread) return;
  for (const participant of thread.participants) {
    if (participant === owner) continue;
    setTeamUpdate(updates, participant, `参与：${item.title}`, thread.lastActiveAt, 1);
  }
}

function collectTeamUpdates(
  items: BacklogItem[],
  threadsByBacklogId: Record<string, TeamHomeThreadSummary>,
): Map<string, TeamMemberUpdate> {
  const updates = new Map<string, TeamMemberUpdate>();
  for (const item of items) {
    if (isVisibleTeamItem(item)) addItemTeamUpdates(updates, item, threadsByBacklogId[item.id]);
  }
  return updates;
}

function deriveTeamFromItems(
  items: BacklogItem[],
  threadsByBacklogId: Record<string, TeamHomeThreadSummary>,
): TeamHomeData['team'] {
  const updates = collectTeamUpdates(items, threadsByBacklogId);
  return teamHomeFixture.team.map((member) => {
    const update = updates.get(member.id);
    const baseMember = { ...member, capabilities: [...member.capabilities] };
    if (!update) return baseMember;
    return {
      ...baseMember,
      currentContext: update.currentContext,
      lastActiveAt: new Date(update.lastActiveAt).toISOString(),
    };
  });
}

export function adaptTeamHomeData(input: TeamHomeAdapterInput): TeamHomeData {
  const { items, threadsByBacklogId = {} } = input;

  const activeStatuses = new Set<BacklogItem['status']>(['approved', 'dispatched']);
  const activeItem = pickActiveItem(items);

  const missions: TeamHomeMissionSummary[] = items
    .filter((item) => activeStatuses.has(item.status))
    .slice(0, MAX_VISIBLE_MISSIONS)
    .map((item) => ({
      id: item.id,
      name: item.title,
      owner: inferOwner(item),
      stage: inferSOPStage(item),
      nextAction: inferNextAction(item),
      updatedAt: new Date(item.updatedAt).toISOString(),
    }));

  const missionOverride = deriveMissionFromItem(activeItem);

  return {
    ...teamHomeFixture,
    mission: {
      ...teamHomeFixture.mission,
      ...missionOverride,
    },
    baton: deriveBatonFromItem(activeItem),
    team: deriveTeamFromItems(items, threadsByBacklogId),
    missions,
  };
}
