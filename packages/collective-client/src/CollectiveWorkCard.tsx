import { useContext, useState } from 'react';
import type { RoadmapAction } from './channel-collaboration.js';
import type { CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { HostWorkPermissionContext } from './use-host-work-policy.js';

export function CollectiveWorkCard({
  work,
  works,
  currentHumanId,
  sourceOwnerHumanId,
  canSteward,
  participants,
  humanNames,
  onCommit,
  onDecline,
  onAcceptResult,
  onRequestRevision,
  onComplete,
  roadmapActions = [],
}: {
  readonly work: CollectiveWorkProjection;
  readonly works: readonly CollectiveWorkProjection[];
  readonly currentHumanId: string;
  readonly sourceOwnerHumanId: string;
  readonly canSteward: boolean;
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly onCommit: (work: CollectiveWorkProjection, participant?: CollectiveParticipant) => void;
  readonly onDecline: (work: CollectiveWorkProjection) => void;
  readonly onAcceptResult: (work: CollectiveWorkProjection) => void;
  readonly onRequestRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onComplete: (work: CollectiveWorkProjection) => void;
  readonly roadmapActions?: readonly RoadmapAction[];
}) {
  const home = useContext(HostWorkPermissionContext);
  const ownerProposal =
    work.proposedBy.kind === 'agent' && work.proposedBy.humanId === currentHumanId && Boolean(work.proposedRequestKind);
  const homeProposal =
    ownerProposal &&
    work.proposedBy.kind === 'agent' &&
    work.proposedBy.connectionId === home.connectionId &&
    home.request;
  const ownParticipants = participants.filter(
    (participant) =>
      participant.humanId === currentHumanId &&
      participant.availability === 'declared' &&
      participant.channelIds.includes(work.sourceLocation.channelId),
  );
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? 'Collective 成员') : undefined;
  const dependencies = work.dependencyWorkIds
    .map((dependencyId) => works.find((candidate) => candidate.workId === dependencyId)?.title)
    .filter((title): title is string => Boolean(title));
  const canDecline = canSteward || work.proposedBy.humanId === currentHumanId || sourceOwnerHumanId === currentHumanId;
  const execution = workExecutionPresentation(work);
  return (
    <section className="collective-work-card" aria-label={`工作 · ${work.title}`} data-work-status={work.status}>
      <header>
        <span>{work.lifecycle === 'proposed' ? '工作提议 · 来自这条消息' : '工作 · 来自这条消息'}</span>
        <strong>{execution.statusLabel}</strong>
      </header>
      <h3>{work.title}</h3>
      {work.intendedOutcome !== work.title && <p>{work.intendedOutcome}</p>}
      <WorkOwnership work={work} accountable={accountable} execution={execution} />
      {dependencies.length > 0 && <p className="work-dependencies">前置 · {dependencies.join('、')}</p>}
      <WorkResultStatus work={work} />
      {work.lifecycle === 'proposed' && ownerProposal && (
        <div className="work-actions">
          {homeProposal ? (
            <button type="button" className="quiet-action" onClick={() => home.request?.(work)}>
              授权决定…
            </button>
          ) : (
            <span>请在提议猫所属的 Café 中决定授权。</span>
          )}
        </div>
      )}
      {work.lifecycle === 'proposed' && !ownerProposal && (
        <div className="work-actions">
          {ownParticipants.map((participant) => (
            <button
              key={`${participant.connectionId}:${participant.catId}`}
              type="button"
              onClick={() => onCommit(work, participant)}
            >
              交给 {participant.displayName}
            </button>
          ))}
          <button type="button" onClick={() => onCommit(work)}>
            由我负责
          </button>
          {canDecline && (
            <button type="button" className="quiet-action" onClick={() => onDecline(work)}>
              先不跟踪
            </button>
          )}
        </div>
      )}
      {work.status === 'ready' && !work.assignment && work.accountableHumanId === currentHumanId && (
        <div className="work-actions">
          <button type="button" onClick={() => onComplete(work)}>
            标记完成
          </button>
        </div>
      )}
      {work.lifecycle === 'result_ready' && work.accountableHumanId === currentHumanId && (
        <WorkResultReview work={work} onAcceptResult={onAcceptResult} onRequestRevision={onRequestRevision} />
      )}
      {roadmapActions.length > 0 && work.lifecycle !== 'proposed' && work.lifecycle !== 'declined' && (
        <div className="work-actions work-secondary-actions">
          {roadmapActions.map((action) => (
            <button key={action.label} type="button" className="quiet-action" onClick={() => action.onInvoke(work)}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkOwnership({
  work,
  accountable,
  execution,
}: {
  readonly work: CollectiveWorkProjection;
  readonly accountable?: string;
  readonly execution: ReturnType<typeof workExecutionPresentation>;
}) {
  return (
    <>
      {work.assignment && accountable && (
        <p className="work-ownership">
          {work.assignment.displayName} {execution.assignmentAction} · {accountable} 负责
        </p>
      )}
      {!work.assignment && accountable && <p className="work-ownership">{accountable} 负责</p>}
      {execution.admissionMessage && <p className="work-admission">{execution.admissionMessage}</p>}
    </>
  );
}

function WorkResultStatus({ work }: { readonly work: CollectiveWorkProjection }) {
  if (work.lifecycle === 'result_ready') {
    return <p className="work-result">结果 v{work.resultRevision ?? 1} 已回到原讨论，等负责人确认。</p>;
  }
  const latestRequest = work.history.findLast((entry) => entry.action === 'revision_requested');
  if (work.lifecycle !== 'in_progress' || !latestRequest?.note) return null;
  return (
    <p className="work-result">
      已退回结果 v{latestRequest.resultRevision ?? 1} · {latestRequest.note}
    </p>
  );
}

function WorkResultReview({
  work,
  onAcceptResult,
  onRequestRevision,
}: {
  readonly work: CollectiveWorkProjection;
  readonly onAcceptResult: (work: CollectiveWorkProjection) => void;
  readonly onRequestRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState('');
  const submitRevision = () => {
    const exactFeedback = feedback.trim();
    if (!onRequestRevision || !exactFeedback) return;
    void onRequestRevision(work, exactFeedback)
      .then(() => setFeedback(''))
      .catch(() => undefined);
  };
  return (
    <div className="work-result-review">
      {onRequestRevision && (
        <label>
          <span>需要修改什么</span>
          <textarea
            aria-label="修订反馈"
            value={feedback}
            onChange={(event) => setFeedback(event.currentTarget.value)}
            placeholder="说明要补充或修改的具体内容"
            maxLength={1000}
          />
        </label>
      )}
      <div className="work-actions">
        {onRequestRevision && (
          <button type="button" className="quiet-action" disabled={!feedback.trim()} onClick={submitRevision}>
            退回修改
          </button>
        )}
        <button type="button" onClick={() => onAcceptResult(work)}>
          确认结果并完成
        </button>
      </div>
    </div>
  );
}

export function workStatusLabel(status: CollectiveWorkProjection['status']): string {
  const labels: Record<CollectiveWorkProjection['status'], string> = {
    proposed: '等待确认',
    ready: '可以开始',
    blocked: '等待前置工作',
    in_progress: '推进中',
    result_ready: '结果待确认',
    completed: '已完成',
    declined: '不跟踪',
    cancelled: '已取消',
  };
  return labels[status];
}

/** Live Service permission and current Host receipt govern execution; first acceptance stays historical. */
export function workExecutionPresentation(work: CollectiveWorkProjection): {
  readonly statusLabel: string;
  readonly assignmentAction: '推进' | '已接下';
  readonly admissionMessage?: string;
} {
  const currentExecution = work.executionAuthority ?? work.acceptance;
  const active = work.lifecycle === 'committed' || work.lifecycle === 'in_progress';
  const currentStatus = work.executionStatus;
  if (
    active &&
    currentStatus?.revision === (work.executionAuthority?.revision ?? 1) &&
    currentStatus.state === 'unavailable'
  ) {
    return {
      statusLabel: '当前无法执行',
      assignmentAction: '已接下',
      admissionMessage: executionUnavailableMessage(currentStatus.reason),
    };
  }
  if (!currentExecution) return { statusLabel: workStatusLabel(work.status), assignmentAction: '推进' };
  const admission = currentExecution.hostAdmission;
  const assignmentAction =
    admission?.state === 'admitted' && work.lifecycle === 'in_progress' && work.status === 'in_progress'
      ? '推进'
      : '已接下';
  if (!active) {
    return { statusLabel: workStatusLabel(work.status), assignmentAction };
  }
  if (admission?.state === 'rejected') {
    return {
      statusLabel: '未获准执行',
      assignmentAction,
      admissionMessage:
        admission.reason === 'WORK_DELEGATION_UNAVAILABLE'
          ? '主人委托已失效或撤回，当前未获准执行。'
          : '家内未批准当前执行。',
    };
  }
  if (!admission) return { statusLabel: '已接下，待家内准入', assignmentAction };
  return {
    statusLabel:
      work.lifecycle === 'committed' && work.status !== 'blocked' ? '已准入，待开始' : workStatusLabel(work.status),
    assignmentAction,
  };
}

function executionUnavailableMessage(reason?: string): string {
  switch (reason) {
    case 'WORK_DELEGATION_UNAVAILABLE':
      return '主人委托已失效或撤回，当前无法继续执行。';
    case 'PARTICIPATION_REVOKED':
      return '猫的公共参与已撤回，当前无法继续执行。';
    case 'WORK_SOURCE_UNAVAILABLE':
      return '来源消息或相关成员已不可用，当前无法继续执行。';
    case 'MEMBERSHIP_REVOKED':
      return '相关成员已退出或被移除，当前无法继续执行。';
    case 'WORK_ADMISSION_NOT_CURRENT':
      return '当前执行的家内准入已失效，无法继续执行。';
    case 'CONNECTION_REVOKED':
      return '所属 Café 的连接已撤回，当前无法继续执行。';
    default:
      return '当前执行权限不可用。';
  }
}
