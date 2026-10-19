import { useState } from 'react';
import type { RoadmapAction } from './channel-collaboration.js';
import type { CollectiveParticipant, CollectiveWorkProjection } from './client-types.js';
import { useCollectiveText } from './collective-copy.js';

export function WorkActions({
  work,
  currentHumanId,
  ownerProposal,
  requestHome,
  ownParticipants,
  canDecline,
  roadmapActions,
  onCommit,
  onDecline,
  onAcceptResult,
  onRequestRevision,
  onComplete,
}: {
  readonly work: CollectiveWorkProjection;
  readonly currentHumanId: string;
  readonly ownerProposal: boolean;
  readonly requestHome?: () => void;
  readonly ownParticipants: readonly CollectiveParticipant[];
  readonly canDecline: boolean;
  readonly roadmapActions: readonly RoadmapAction[];
  readonly onCommit: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => void;
  readonly onDecline: (work: CollectiveWorkProjection) => void;
  readonly onAcceptResult: (work: CollectiveWorkProjection) => void;
  readonly onRequestRevision?: (work: CollectiveWorkProjection, feedback: string) => Promise<void>;
  readonly onComplete: (work: CollectiveWorkProjection) => void;
}) {
  const t = useCollectiveText();
  if (work.lifecycle === 'proposed' && ownerProposal) {
    return (
      <div className="work-actions">
        {requestHome ? (
          <button type="button" className="quiet-action" onClick={requestHome}>
            {t('待你决定…')}
          </button>
        ) : (
          <span>{t('请在提议猫所属的 Café 中决定授权。')}</span>
        )}
      </div>
    );
  }
  return (
    <>
      {work.lifecycle === 'proposed' && (
        <CommitActions
          work={work}
          participants={ownParticipants}
          canDefer
          canDecline={canDecline}
          {...{ onCommit, onDecline }}
        />
      )}
      {work.status === 'unassigned' && (
        <CommitActions
          work={work}
          participants={ownParticipants}
          canDefer={false}
          canDecline={false}
          {...{ onCommit, onDecline }}
        />
      )}
      {work.status === 'ready' && !work.assignment && work.accountableHumanId === currentHumanId && (
        <div className="work-actions">
          <button type="button" onClick={() => onComplete(work)}>
            {t('标记完成')}
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
    </>
  );
}

function CommitActions({
  work,
  participants,
  canDefer,
  canDecline,
  onCommit,
  onDecline,
}: {
  readonly work: CollectiveWorkProjection;
  readonly participants: readonly CollectiveParticipant[];
  readonly canDefer: boolean;
  readonly canDecline: boolean;
  readonly onCommit: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => void;
  readonly onDecline: (work: CollectiveWorkProjection) => void;
}) {
  const t = useCollectiveText();
  return (
    <div className="work-actions">
      {participants.map((participant) => (
        <button
          key={`${participant.connectionId}:${participant.catId}`}
          type="button"
          onClick={() => onCommit(work, participant)}
        >
          {t('交给')} {participant.displayLabel ?? participant.displayName}
        </button>
      ))}
      <button type="button" onClick={() => onCommit(work)}>
        {t('由我负责')}
      </button>
      {canDefer && (
        <button type="button" className="quiet-action" onClick={() => onCommit(work, undefined, 'unassigned')}>
          {t('接纳，稍后指派')}
        </button>
      )}
      {canDecline && (
        <button type="button" className="quiet-action" onClick={() => onDecline(work)}>
          {t('先不跟踪')}
        </button>
      )}
    </div>
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
  const t = useCollectiveText();
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
          <span>{t('需要修改什么')}</span>
          <textarea
            aria-label={t('修订反馈')}
            value={feedback}
            onChange={(event) => setFeedback(event.currentTarget.value)}
            placeholder={t('说明要补充或修改的具体内容')}
            maxLength={1000}
          />
        </label>
      )}
      <div className="work-actions">
        {onRequestRevision && (
          <button type="button" className="quiet-action" disabled={!feedback.trim()} onClick={submitRevision}>
            {t('退回修改')}
          </button>
        )}
        <button type="button" onClick={() => onAcceptResult(work)}>
          {t('确认结果并完成')}
        </button>
      </div>
    </div>
  );
}
