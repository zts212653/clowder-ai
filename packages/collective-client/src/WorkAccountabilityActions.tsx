import { useState } from 'react';
import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import { participantKey } from './participant-identity.js';
import { canChangeWorkResponsibility, workAccountabilityRequestState } from './roadmap-view-model.js';

type AccountabilityRequest = NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number];

export function WorkAccountabilityActions({
  roadmap,
  roadmaps = [roadmap],
  work,
  currentHumanId,
  humans,
  participants,
  onCommit,
  onRequest,
  onRespond,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly roadmaps?: readonly CollectiveRoadmapRecord[];
  readonly work: CollectiveWorkProjection;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly onCommit?: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => Promise<void>;
  readonly onRequest?: (
    roadmap: CollectiveRoadmapRecord,
    work: CollectiveWorkProjection,
    targetHumanId: string,
  ) => Promise<void>;
  readonly onRespond?: (
    work: CollectiveWorkProjection,
    request: AccountabilityRequest,
    decision: 'accept' | 'decline',
    participant?: CollectiveParticipant,
  ) => Promise<void>;
}) {
  const [targetHumanId, setTargetHumanId] = useState('');
  const [participantSelection, setParticipantSelection] = useState('self');
  const canChangeResponsibility = canChangeWorkResponsibility(roadmap, work);
  const requestState = workAccountabilityRequestState(work, roadmaps);
  const pending = requestState.pending;
  const canRequest =
    canChangeResponsibility &&
    !pending &&
    (work.accountableHumanId === currentHumanId ||
      (!work.accountableHumanId && roadmap.accountableHumanId === currentHumanId));
  const canTakeSelf = canChangeResponsibility && !pending && !work.accountableHumanId;
  const availableTargets = humans.filter((human) => human.humanId !== currentHumanId);
  const ownParticipants = participants.filter(
    (participant) =>
      participant.humanId === currentHumanId &&
      participant.availability === 'declared' &&
      participant.channelIds.includes(work.sourceLocation.channelId),
  );
  const targetedRequest = pending?.targetHumanId === currentHumanId ? pending : undefined;

  if (pending && !requestState.roadmap) return null;
  if (!canTakeSelf && !canRequest && !pending) return null;
  return (
    <section className="work-accountability-actions" aria-label="任务负责人操作">
      {targetedRequest && onRespond ? (
        <>
          <strong>{targetedRequest.requestedByDisplayName} 邀请你负责</strong>
          <p>接受后你会成为负责人；也可以同时选择自己 Café 里的猫来推进。</p>
          <label>
            <span>接下任务后</span>
            <select
              aria-label="接下任务后"
              value={participantSelection}
              onChange={(event) => setParticipantSelection(event.target.value)}
            >
              <option value="self">我自己推进</option>
              {ownParticipants.map((participant) => (
                <option key={participantKey(participant)} value={participantKey(participant)}>
                  交给 {participant.displayName}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              type="button"
              className="project-primary-action"
              onClick={() => {
                const participant = ownParticipants.find(
                  (candidate) => participantKey(candidate) === participantSelection,
                );
                void onRespond(work, targetedRequest, 'accept', participant).catch(() => undefined);
              }}
            >
              接受负责
            </button>
            <button
              type="button"
              onClick={() => void onRespond(work, targetedRequest, 'decline').catch(() => undefined)}
            >
              暂不接受
            </button>
          </div>
        </>
      ) : pending ? (
        <p>已邀请 {pending.targetDisplayName}，等待回复。</p>
      ) : (
        <>
          {canTakeSelf && onCommit && (
            <button
              type="button"
              className="project-primary-action"
              onClick={() => void onCommit(work, undefined, 'self').catch(() => undefined)}
            >
              我来负责
            </button>
          )}
          {canRequest && onRequest && availableTargets.length > 0 && (
            <div className="work-accountability-invite">
              <label>
                <span>邀请负责人</span>
                <select
                  aria-label="邀请负责人"
                  value={targetHumanId}
                  onChange={(event) => setTargetHumanId(event.target.value)}
                >
                  <option value="">选择共同体成员</option>
                  {availableTargets.map((human) => (
                    <option key={human.humanId} value={human.humanId}>
                      {human.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!targetHumanId}
                onClick={() => targetHumanId && void onRequest(roadmap, work, targetHumanId).catch(() => undefined)}
              >
                发送邀请
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
