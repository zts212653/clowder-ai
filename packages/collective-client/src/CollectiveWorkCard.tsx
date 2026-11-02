import { useContext } from 'react';
import { WorkActions } from './CollectiveWorkActions.js';
import type { RoadmapAction } from './channel-collaboration.js';
import type { CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { HostWorkPermissionContext } from './use-host-work-policy.js';
import { WorkTimeCommandContext } from './WorkTimeCommandContext.js';
import { WorkTimePanel } from './WorkTimePanel.js';
import { WorkTimeSummary } from './WorkTimeSummary.js';
import { workExecutionPresentation } from './work-execution-presentation.js';

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
  readonly onCommit: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => void;
  readonly onDecline: (work: CollectiveWorkProjection) => void;
  readonly onAcceptResult: (work: CollectiveWorkProjection) => void;
  readonly onRequestRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onComplete: (work: CollectiveWorkProjection) => void;
  readonly roadmapActions?: readonly RoadmapAction[];
}) {
  const { change: changeTime } = useContext(WorkTimeCommandContext);
  const home = useContext(HostWorkPermissionContext);
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
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
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? t('共同体成员')) : undefined;
  const dependencies = work.dependencyWorkIds
    .map((dependencyId) => works.find((candidate) => candidate.workId === dependencyId)?.title)
    .filter((title): title is string => Boolean(title));
  const canDecline = canSteward || work.proposedBy.humanId === currentHumanId || sourceOwnerHumanId === currentHumanId;
  const execution = workExecutionPresentation(work);
  return (
    <section
      className="collective-work-card"
      aria-label={`${t('任务')} · ${work.title}`}
      data-work-status={work.status}
      data-work-lifecycle={work.lifecycle}
    >
      <header>
        <span>{t(work.lifecycle === 'proposed' ? '任务建议 · 来自这条消息' : '任务 · 来自这条消息')}</span>
        <strong>
          {ownerProposal && homeProposal && work.lifecycle === 'proposed' ? t('待你决定') : t(execution.statusLabel)}
        </strong>
      </header>
      <h3>{work.title}</h3>
      {work.intendedOutcome !== work.title && <p>{work.intendedOutcome}</p>}
      {work.lifecycle === 'proposed' && (
        <p className="work-proposal-origin">
          {humanNames[work.proposedBy.humanId] ?? t('共同体成员')} {t('提出')} ·{' '}
          {ownerProposal
            ? `${t('等')} ${humanNames[work.proposedBy.humanId] ?? t('共同体成员')} ${t('决定')}`
            : t('待成员接下')}
        </p>
      )}
      <WorkOwnership work={work} accountable={accountable} execution={execution} />
      {dependencies.length > 0 && (
        <p className="work-dependencies">
          {t('前置任务')} · {dependencies.join(language === 'en' ? ', ' : '、')}
        </p>
      )}
      <WorkResultStatus work={work} />
      {work.lifecycle !== 'proposed' && (
        <details className="channel-work-dates">
          <summary>
            {language === 'en' ? 'Dates' : '时间'}
            <WorkTimeSummary work={work} />
          </summary>
          <WorkTimePanel work={work} currentHumanId={currentHumanId} onChange={changeTime} />
        </details>
      )}
      <WorkActions
        work={work}
        currentHumanId={currentHumanId}
        ownerProposal={ownerProposal}
        requestHome={homeProposal ? () => home.request?.(work) : undefined}
        ownParticipants={ownParticipants}
        canDecline={canDecline}
        roadmapActions={roadmapActions}
        onCommit={onCommit}
        onDecline={onDecline}
        onAcceptResult={onAcceptResult}
        onRequestRevision={onRequestRevision}
        onComplete={onComplete}
      />
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
  const t = useCollectiveText();
  return (
    <>
      {work.assignment && accountable && (
        <p className="work-ownership">
          {work.assignment.displayName} {t(execution.assignmentAction)} · {accountable} {t('负责')}
        </p>
      )}
      {!work.assignment && accountable && (
        <p className="work-ownership">
          {accountable} {t('负责')}
        </p>
      )}
      {!work.assignment && !accountable && work.status === 'unassigned' && (
        <p className="work-ownership">{t('未分配 · 等待负责人接下')}</p>
      )}
      {execution.admissionMessage && <p className="work-admission">{t(execution.admissionMessage)}</p>}
    </>
  );
}

function WorkResultStatus({ work }: { readonly work: CollectiveWorkProjection }) {
  const language = useCollectiveLanguage();
  if (work.lifecycle === 'result_ready') {
    const resultRevision = work.resultRevision ?? 1;
    return (
      <p className="work-result">
        {language === 'en'
          ? `Result v${resultRevision} returned to the original discussion and awaits its owner.`
          : `结果 v${resultRevision} 已回到原讨论，等负责人确认。`}
      </p>
    );
  }
  const latestRequest = work.history.findLast((entry) => entry.action === 'revision_requested');
  if (work.lifecycle !== 'in_progress' || !latestRequest?.note) return null;
  return (
    <p className="work-result">
      {language === 'en' ? 'Revision requested for result' : '已退回结果'} v{latestRequest.resultRevision ?? 1} ·{' '}
      {latestRequest.note}
    </p>
  );
}
