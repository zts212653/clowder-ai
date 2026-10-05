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
import { collectiveClientNamespace } from './human-send-custody.js';
import { collectiveClientErrorMessage } from './use-human-auth-session.js';
import type { InformalVoteDraft } from './VoteCard.js';

export function useCollectiveCollaboration(input: {
  readonly snapshot: ClientSnapshot;
  readonly setSnapshot: Dispatch<SetStateAction<ClientSnapshot>>;
  readonly currentNamespace: MutableRefObject<string | undefined>;
  readonly request: ClientRequest;
  readonly refresh: () => Promise<void>;
}) {
  const running = useRef<Promise<void>>();
  const command = useCallback(
    (path: string, payload: Record<string, unknown>, acceptedLabel: string) => {
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
          delivery: { kind: 'requesting', label: '正在更新共同现场…' },
        }));
        try {
          await input.request(path, {
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
    proposeWork: (sourceEventId: string) =>
      command('/api/collaboration/work/propose', { sourceEventId }, '工作提议已挂回原消息'),
    commitWork: (work: CollectiveWorkProjection, participant?: CollectiveParticipant) =>
      command(
        '/api/collaboration/work/commit',
        {
          workId: work.workId,
          expectedRevision: work.revision,
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
        participant ? `已交给 ${participant.displayName}，责任仍由你确认` : '这项工作已由你承诺',
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
            '结果已确认，工作历史会继续保留',
          )
        : Promise.reject(new Error('当前工作没有可确认的结果')),
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
            '反馈已送达，猫会沿同一工作返回新版',
          )
        : Promise.reject(new Error('当前工作没有可退回的结果')),
    completeWork: (work: CollectiveWorkProjection) =>
      command(
        '/api/collaboration/work/complete',
        { workId: work.workId, expectedRevision: work.revision },
        '这项工作已完成，历史会继续保留',
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
          title: `${work.sourceLocation.channelId} 路线`,
          purpose: `沿着“${work.title}”把承诺、依赖和结果留在同一条路线上。`,
          workIds: [work.workId],
        },
        '路线已从这项工作长出来',
      ),
    setRoadmapWorks: (roadmap: CollectiveRoadmapRecord, workIds: readonly string[]) =>
      command(
        '/api/collaboration/roadmaps/works',
        { roadmapId: roadmap.roadmapId, expectedRevision: roadmap.revision, workIds },
        '路线中的工作已更新',
      ),
    setRoadmapStatus: (roadmap: CollectiveRoadmapRecord, status: 'active' | 'completed') =>
      command(
        '/api/collaboration/roadmaps/status',
        { roadmapId: roadmap.roadmapId, expectedRevision: roadmap.revision, status },
        status === 'completed' ? '路线已完成，历史会继续保留' : '路线已重新打开',
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
        '投票人、规则与路线 authority 已冻结',
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
