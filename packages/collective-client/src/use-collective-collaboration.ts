import { collectiveWorkProjectionSchema } from '@cat-cafe/shared';
import { type Dispatch, type MutableRefObject, type SetStateAction, useCallback, useRef } from 'react';
import type { ClientRequest } from './client-request.js';
import type {
  ClientSnapshot,
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveParticipant,
  CollectiveReactionEmoji,
  CollectiveRoadmapRecord,
  CollectiveVoteProjection,
  CollectiveWorkProjection,
} from './client-types.js';
import { acknowledgeCollaborationCommand, prepareCollaborationCommand } from './collaboration-command-custody.js';
import { publishCollectiveAccountabilityChanged } from './collective-accountability-events.js';
import { collectiveClientNamespace } from './human-send-custody.js';
import type { ProjectSuggestionEdits } from './ProjectSuggestionActions.js';
import { collectiveClientErrorMessage } from './use-human-auth-session.js';
import type { InformalVoteDraft } from './VoteCard.js';

export interface ProjectTaskResponsibility {
  readonly accountability: 'self' | 'unassigned';
  readonly requestedAccountableHumanId?: string;
}

type WorkAccountabilityRequest = NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number];

export function useCollectiveCollaboration(input: {
  readonly snapshot: ClientSnapshot;
  readonly setSnapshot: Dispatch<SetStateAction<ClientSnapshot>>;
  readonly currentNamespace: MutableRefObject<string | undefined>;
  readonly request: ClientRequest;
  readonly refresh: () => Promise<void>;
}) {
  const running = useRef<Promise<void>>();
  const command = useCallback(
    (path: string, payload: Record<string, unknown>, acceptedLabel: string, onAccepted?: (result: unknown) => void) => {
      const { snapshot } = input;
      const namespace = collectiveClientNamespace(snapshot);
      if (!namespace || !snapshot.meta || !snapshot.collective) {
        return Promise.reject(new Error('请先登录并选择 Collective'));
      }
      if (running.current) return Promise.reject(new Error('上一项共同操作仍在确认，请稍后再试。'));
      const fingerprint = { path, ...payload };
      const requestId = prepareCollaborationCommand(localStorage, namespace, fingerprint);
      const run = async () => {
        input.setSnapshot((current) => ({
          ...current,
          delivery: { kind: 'requesting', label: '正在更新…' },
        }));
        try {
          const result = await input.request(path, {
            method: 'POST',
            body: JSON.stringify({
              serviceInstanceId: snapshot.meta?.serviceInstanceId,
              collectiveId: snapshot.collective?.collectiveId,
              requestId,
              ...payload,
            }),
          });
          acknowledgeCollaborationCommand(localStorage, namespace, requestId);
          if (namespace !== input.currentNamespace.current) return;
          await input.refresh();
          if (namespace !== input.currentNamespace.current) return;
          input.setSnapshot((current) => ({
            ...current,
            delivery: { kind: 'accepted', label: acceptedLabel },
            error: undefined,
          }));
          onAccepted?.(result);
        } catch (error) {
          if (namespace !== input.currentNamespace.current) throw error;
          input.setSnapshot((current) => ({
            ...current,
            delivery: { kind: 'failed', label: '共同状态尚未确认，可以重试' },
            error: collectiveClientErrorMessage(error),
          }));
          throw error;
        }
      };
      const promise = run().finally(() => {
        running.current = undefined;
      });
      running.current = promise;
      return promise;
    },
    [input],
  );
  return {
    createProject: (channelId: string, title: string, purpose: string) =>
      command('/api/collaboration/projects/create', { channelId, title, purpose }, '项目已建立，来源已留在频道'),
    createProjectTask: (
      roadmap: CollectiveRoadmapRecord,
      channelId: string,
      title: string,
      intendedOutcome: string,
      responsibility: ProjectTaskResponsibility,
    ) =>
      command(
        '/api/collaboration/projects/tasks/create',
        {
          roadmapId: roadmap.roadmapId,
          expectedRoadmapRevision: roadmap.revision,
          channelId,
          title,
          intendedOutcome,
          accountability: responsibility.accountability,
          ...(responsibility.requestedAccountableHumanId
            ? { requestedAccountableHumanId: responsibility.requestedAccountableHumanId }
            : {}),
        },
        responsibility.requestedAccountableHumanId
          ? '任务已建立，负责人邀请已送达'
          : responsibility.accountability === 'self'
            ? '任务已建立，由你负责'
            : '任务已建立，等待负责人接下',
      ),
    requestWorkAccountability: (
      roadmap: CollectiveRoadmapRecord,
      work: CollectiveWorkProjection,
      targetHumanId: string,
    ) =>
      command(
        '/api/collaboration/work/accountability/request',
        {
          roadmapId: roadmap.roadmapId,
          workId: work.workId,
          expectedRevision: work.revision,
          targetHumanId,
        },
        '负责人邀请已送达',
      ),
    respondWorkAccountability: (
      work: CollectiveWorkProjection,
      accountabilityRequest: WorkAccountabilityRequest,
      decision: 'accept' | 'decline',
      participant?: CollectiveParticipant,
    ) =>
      command(
        '/api/collaboration/work/accountability/respond',
        {
          workId: work.workId,
          expectedRevision: work.revision,
          accountabilityRequestId: accountabilityRequest.accountabilityRequestId,
          decision,
          ...(participant
            ? {
                assignment: {
                  connectionId: participant.connectionId,
                  catId: participant.catId,
                  participationRevision: participant.participationRevision,
                },
              }
            : {}),
        },
        decision === 'accept' ? '你已接下这项任务' : '已回复暂不负责',
        (result) => {
          const parsed = collectiveWorkProjectionSchema.safeParse(result);
          const changed = parsed.success
            ? parsed.data.accountabilityRequests?.find(
                (candidate) => candidate.accountabilityRequestId === accountabilityRequest.accountabilityRequestId,
              )
            : undefined;
          if (!parsed.success || !changed || changed.status === 'pending') return;
          publishCollectiveAccountabilityChanged({
            workId: parsed.data.workId,
            workRevision: parsed.data.revision,
            accountabilityRequestId: changed.accountabilityRequestId,
            status: changed.status,
          });
        },
      ),
    decideProjectWorkSuggestion: (
      roadmap: CollectiveRoadmapRecord,
      work: CollectiveWorkProjection,
      decision: 'accept' | 'ignore',
      edits?: ProjectSuggestionEdits,
    ) => {
      const prepared = prepareProjectSuggestionDecision(
        roadmap,
        work,
        input.snapshot.collaboration?.works,
        decision,
        edits,
      );
      if ('error' in prepared) return Promise.reject(prepared.error);
      return command('/api/collaboration/projects/suggestions/decide', prepared.payload, prepared.acceptedLabel);
    },
    proposeWork: (sourceEventId: string) =>
      command('/api/collaboration/work/propose', { sourceEventId }, '任务建议已挂回原消息'),
    commitWork: (
      work: CollectiveWorkProjection,
      participant?: CollectiveParticipant,
      accountability: 'self' | 'unassigned' = 'self',
    ) =>
      command(
        '/api/collaboration/work/commit',
        {
          workId: work.workId,
          expectedRevision: work.revision,
          ...(accountability === 'unassigned' ? { accountability } : {}),
          ...(participant
            ? {
                assignment: {
                  connectionId: participant.connectionId,
                  catId: participant.catId,
                  participationRevision: participant.participationRevision,
                },
              }
            : {}),
        },
        participant
          ? `已交给 ${participant.displayName}，责任仍由你确认`
          : accountability === 'unassigned'
            ? '这项任务已接纳，等待负责人接下'
            : '这项任务已由你负责',
      ),
    declineWork: (work: CollectiveWorkProjection) =>
      command(
        '/api/collaboration/work/decline',
        { workId: work.workId, expectedRevision: work.revision },
        '这项提议不会进入跟踪',
      ),
    acceptWorkResult: (work: CollectiveWorkProjection) =>
      work.resultEventId
        ? command(
            '/api/collaboration/work/result/accept',
            {
              workId: work.workId,
              expectedRevision: work.revision,
              resultEventId: work.resultEventId,
              resultRevision: work.resultRevision ?? 1,
            },
            '结果已确认，任务动态会继续保留',
          )
        : Promise.reject(new Error('当前任务没有可确认的结果')),
    requestWorkRevision: (work: CollectiveWorkProjection, feedback: string) =>
      work.resultEventId
        ? command(
            '/api/collaboration/work/result/revision',
            {
              workId: work.workId,
              expectedRevision: work.revision,
              resultEventId: work.resultEventId,
              resultRevision: work.resultRevision ?? 1,
              feedback,
            },
            '反馈已送达，猫会沿同一任务返回新版',
          )
        : Promise.reject(new Error('当前任务没有可退回的结果')),
    completeWork: (work: CollectiveWorkProjection) =>
      command(
        '/api/collaboration/work/complete',
        { workId: work.workId, expectedRevision: work.revision },
        '这项任务已完成，动态会继续保留',
      ),
    setWorkDependencies: (work: CollectiveWorkProjection, dependencyWorkIds: readonly string[]) =>
      command(
        '/api/collaboration/work/dependencies',
        { workId: work.workId, expectedRevision: work.revision, dependencyWorkIds },
        '前置关系已更新',
      ),
    createRoadmap: (work: CollectiveWorkProjection) =>
      command(
        '/api/collaboration/roadmaps',
        {
          sourceEventId: work.sourceEventId,
          title: `${work.sourceLocation.channelId} 项目`,
          purpose: `围绕“${work.title}”把目标、任务、前置关系和结果留在同一个项目里。`,
          workIds: [work.workId],
        },
        '项目已从这项任务建立',
      ),
    setRoadmapWorks: (roadmap: CollectiveRoadmapRecord, workIds: readonly string[]) =>
      command(
        '/api/collaboration/roadmaps/works',
        { roadmapId: roadmap.roadmapId, expectedRevision: roadmap.revision, workIds },
        '项目中的任务已更新',
      ),
    setRoadmapStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') =>
      command(
        '/api/collaboration/roadmaps/status',
        { roadmapId: roadmap.roadmapId, expectedRevision: roadmap.revision, status },
        status === 'completed' ? '项目已完成，动态会继续保留' : '项目已重新打开',
      ),
    createVote: (sourceEventId: string, draft: InformalVoteDraft) =>
      command('/api/collaboration/votes', { sourceEventId, ...draft }, '随手投票已挂回原消息'),
    castVote: (vote: CollectiveVoteProjection, optionId: string) =>
      command('/api/collaboration/votes/cast', { voteId: vote.voteId, optionId }, '你的偏好已更新'),
    closeVote: (vote: CollectiveVoteProjection) =>
      command('/api/collaboration/votes/close', { voteId: vote.voteId }, '投票已结束；结果仍只是偏好'),
    createBindingVote: (roadmap: CollectiveRoadmapRecord, draft: InformalVoteDraft) =>
      command(
        '/api/collaboration/binding-votes',
        { roadmapId: roadmap.roadmapId, expectedRoadmapRevision: roadmap.revision, ...draft },
        '投票人、规则与项目负责人权限已记录',
      ),
    castBindingVote: (vote: CollectiveBindingVoteProjection, choice: CollectiveBindingVoteChoice) =>
      command('/api/collaboration/binding-votes/cast', { bindingVoteId: vote.bindingVoteId, choice }, '你的票已更新'),
    withdrawBindingVote: (vote: CollectiveBindingVoteProjection) =>
      command('/api/collaboration/binding-votes/withdraw', { bindingVoteId: vote.bindingVoteId }, '你的票已撤回'),
    settleBindingVote: (vote: CollectiveBindingVoteProjection) =>
      command(
        '/api/collaboration/binding-votes/settle',
        { bindingVoteId: vote.bindingVoteId },
        '本轮已结算；通过时只生成 Decision',
      ),
    setReaction: (eventId: string, emoji: CollectiveReactionEmoji, active: boolean) =>
      command('/api/collaboration/reactions/set', { eventId, emoji, active }, active ? '回应已留下' : '回应已收回'),
  };
}

function prepareProjectSuggestionDecision(
  roadmap: CollectiveRoadmapRecord,
  work: CollectiveWorkProjection,
  works: readonly CollectiveWorkProjection[] | undefined,
  decision: 'accept' | 'ignore',
  edits?: ProjectSuggestionEdits,
): { payload: Record<string, unknown>; acceptedLabel: string } | { error: Error } {
  const suggestion = work.projectSuggestion;
  if (!suggestion || suggestion.roadmapId !== roadmap.roadmapId) {
    return { error: new Error('当前任务不是这个项目的待判断建议') };
  }
  const target = suggestion.prerequisiteForWorkId
    ? works?.find((candidate) => candidate.workId === suggestion.prerequisiteForWorkId)
    : undefined;
  if (suggestion.prerequisiteForWorkId && !target) {
    return { error: new Error('建议所指的前置目标当前不可读') };
  }
  return {
    payload: {
      workId: work.workId,
      expectedRevision: work.revision,
      expectedRoadmapRevision: roadmap.revision,
      ...(target ? { expectedTargetWorkRevision: target.revision } : {}),
      decision,
      ...(decision === 'accept' && edits ? edits : {}),
      ...(decision === 'ignore' ? { reason: '暂不纳入当前项目' } : {}),
    },
    acceptedLabel: decision === 'accept' ? '建议已纳入项目，等待负责人接下' : '建议已忽略',
  };
}
