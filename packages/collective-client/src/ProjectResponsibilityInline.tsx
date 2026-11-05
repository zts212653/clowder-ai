import { useState } from 'react';
import type { CollectiveMemberDirectory, CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import { canChangeWorkResponsibility, workAccountabilityRequestState } from './roadmap-view-model.js';

export function ProjectResponsibilityInline({
  roadmap,
  roadmaps = [roadmap],
  work,
  currentHumanId,
  humans,
  onCommit,
  onRequest,
  onRespond,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly roadmaps?: readonly CollectiveRoadmapRecord[];
  readonly work: CollectiveWorkProjection;
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly onCommit?: (
    work: CollectiveWorkProjection,
    participant?: undefined,
    accountability?: 'self' | 'unassigned',
  ) => Promise<void>;
  readonly onRequest?: (
    roadmap: CollectiveRoadmapRecord,
    work: CollectiveWorkProjection,
    targetHumanId: string,
  ) => Promise<void>;
  readonly onRespond?: (
    work: CollectiveWorkProjection,
    request: NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number],
    decision: 'accept' | 'decline',
  ) => Promise<void>;
}) {
  const [selection, setSelection] = useState('self');
  if (work.accountableHumanId) return null;
  const requestState = workAccountabilityRequestState(work, roadmaps);
  const pending = requestState.pending;
  if (pending) {
    if (!requestState.roadmap) return null;
    if (pending.targetHumanId !== currentHumanId) {
      return <span className="project-responsibility-pending">已邀请 {pending.targetDisplayName}</span>;
    }
    if (!onRespond) return null;
    return (
      <fieldset className="project-responsibility-inline" aria-label="卡内指定负责人">
        <span>{pending.requestedByDisplayName} 邀请你负责</span>
        <div>
          <button type="button" onClick={() => void onRespond(work, pending, 'accept').catch(() => undefined)}>
            接受
          </button>
          <button type="button" onClick={() => void onRespond(work, pending, 'decline').catch(() => undefined)}>
            暂不接受
          </button>
        </div>
      </fieldset>
    );
  }
  if (!canChangeWorkResponsibility(roadmap, work)) return null;
  if (roadmap.accountableHumanId !== currentHumanId || (!onCommit && !onRequest)) return null;
  return (
    <fieldset className="project-responsibility-inline" aria-label="卡内指定负责人">
      <label>
        <span className="sr-only">负责人</span>
        <select value={selection} onChange={(event) => setSelection(event.currentTarget.value)}>
          <option value="self">我负责</option>
          {humans
            .filter((human) => human.humanId !== currentHumanId)
            .map((human) => (
              <option key={human.humanId} value={human.humanId}>
                {human.displayName}
              </option>
            ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => {
          if (selection === 'self') void onCommit?.(work, undefined, 'self').catch(() => undefined);
          else void onRequest?.(roadmap, work, selection).catch(() => undefined);
        }}
      >
        指定
      </button>
    </fieldset>
  );
}
