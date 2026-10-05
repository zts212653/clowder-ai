import { useState } from 'react';
import type { CollectiveVoteProjection } from './client-types.js';
import { type VoteDraft, VoteDraftForm } from './VoteDraftForm.js';

export type InformalVoteDraft = VoteDraft;

export function InformalVoteComposer({
  sourceEventId,
  sourceBody,
  onCreate,
  onCancel,
}: {
  readonly sourceEventId: string;
  readonly sourceBody: string;
  readonly onCreate: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
  readonly onCancel: () => void;
}) {
  return (
    <VoteDraftForm
      initialQuestion={sourceBody}
      title="随手问问"
      explanation="只表达偏好，不会形成 Decision"
      submitLabel="发布投票"
      onSubmit={async (draft) => {
        await onCreate(sourceEventId, draft);
        onCancel();
      }}
      onCancel={onCancel}
    />
  );
}

export function VoteCreator({
  sourceEventId,
  sourceBody,
  onCreate,
}: {
  readonly sourceEventId: string;
  readonly sourceBody: string;
  readonly onCreate: (sourceEventId: string, draft: InformalVoteDraft) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="vote-create-action" onClick={() => setOpen(true)}>
        发起随手投票
      </button>
    );
  }
  return (
    <InformalVoteComposer
      sourceEventId={sourceEventId}
      sourceBody={sourceBody}
      onCreate={onCreate}
      onCancel={() => setOpen(false)}
    />
  );
}

export function InformalVoteCard({
  vote,
  currentHumanId,
  canSteward,
  onCast,
  onClose,
}: {
  readonly vote: CollectiveVoteProjection;
  readonly currentHumanId: string;
  readonly canSteward: boolean;
  readonly onCast: (vote: CollectiveVoteProjection, optionId: string) => void;
  readonly onClose: (vote: CollectiveVoteProjection) => void;
}) {
  const mine = vote.ballots.find((ballot) => ballot.humanId === currentHumanId)?.optionId;
  const open = vote.status === 'open';
  const status = vote.status === 'open' ? '仍在收集' : vote.status === 'expired' ? '已到截止时间' : '发起人已结束';
  return (
    <section className="informal-vote-card" aria-label={`投票 · ${vote.question}`} data-vote-status={vote.status}>
      <header>
        <span>随手问问 · 不形成决定</span>
        <strong>{status}</strong>
      </header>
      <h3>{vote.question}</h3>
      <p className="vote-meta">实名 · 当前成员可参与 · 截止 {formatDeadline(vote.closesAt)}</p>
      <div className="vote-options">
        {vote.options.map((option) => {
          const ballots = vote.ballots.filter((ballot) => ballot.optionId === option.optionId);
          return (
            <button
              key={option.optionId}
              type="button"
              aria-pressed={mine === option.optionId}
              disabled={!open}
              onClick={() => onCast(vote, option.optionId)}
            >
              <span>{option.label}</span>
              <strong>{ballots.length} 票</strong>
              {ballots.length > 0 && <small>{ballots.map((ballot) => ballot.displayName).join('、')}</small>}
            </button>
          );
        })}
      </div>
      {open && (vote.createdBy.humanId === currentHumanId || canSteward) && (
        <button type="button" className="vote-close-action" onClick={() => onClose(vote)}>
          结束投票
        </button>
      )}
    </section>
  );
}

function formatDeadline(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
