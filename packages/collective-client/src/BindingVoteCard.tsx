import { useState } from 'react';
import type {
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveDecisionRecord,
  CollectiveRoadmapRecord,
} from './client-types.js';
import { type VoteDraft, VoteDraftForm } from './VoteDraftForm.js';

export function BindingVoteSection({
  roadmap,
  votes,
  decisions,
  currentHumanId,
  onCreate,
  onCast,
  onWithdraw,
  onSettle,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly votes: readonly CollectiveBindingVoteProjection[];
  readonly decisions: readonly CollectiveDecisionRecord[];
  readonly currentHumanId: string;
  readonly onCreate: (roadmap: CollectiveRoadmapRecord, draft: VoteDraft) => Promise<void>;
  readonly onCast: (vote: CollectiveBindingVoteProjection, choice: CollectiveBindingVoteChoice) => void;
  readonly onWithdraw: (vote: CollectiveBindingVoteProjection) => void;
  readonly onSettle: (vote: CollectiveBindingVoteProjection) => void;
}) {
  const relevant = votes.filter((vote) => vote.target.roadmapId === roadmap.roadmapId);
  const hasUnsettledRound = relevant.some((vote) => vote.lifecycle === 'open');
  return (
    <section className="binding-vote-section" aria-label="路线判断">
      {relevant.map((vote) => (
        <BindingVoteCard
          key={vote.bindingVoteId}
          vote={vote}
          decision={decisions.find((decision) => decision.decisionId === vote.decisionId)}
          currentHumanId={currentHumanId}
          onCast={onCast}
          onWithdraw={onWithdraw}
          onSettle={onSettle}
        />
      ))}
      {roadmap.accountableHumanId === currentHumanId && !hasUnsettledRound && (
        <BindingVoteCreator roadmap={roadmap} onCreate={onCreate} />
      )}
    </section>
  );
}

function BindingVoteCreator({
  roadmap,
  onCreate,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly onCreate: (roadmap: CollectiveRoadmapRecord, draft: VoteDraft) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="binding-vote-create" onClick={() => setOpen(true)}>
        发起有约束力的判断
      </button>
    );
  }
  return (
    <VoteDraftForm
      initialQuestion={`${roadmap.title}接下来采用哪一种方案？`}
      title="路线判断"
      explanation="冻结投票人和规则；通过只生成 Decision"
      submitLabel="冻结并开票"
      onSubmit={async (draft) => {
        await onCreate(roadmap, draft);
        setOpen(false);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

function BindingVoteCard({
  vote,
  decision,
  currentHumanId,
  onCast,
  onWithdraw,
  onSettle,
}: {
  readonly vote: CollectiveBindingVoteProjection;
  readonly decision?: CollectiveDecisionRecord;
  readonly currentHumanId: string;
  readonly onCast: (vote: CollectiveBindingVoteProjection, choice: CollectiveBindingVoteChoice) => void;
  readonly onWithdraw: (vote: CollectiveBindingVoteProjection) => void;
  readonly onSettle: (vote: CollectiveBindingVoteProjection) => void;
}) {
  const mine = vote.ballots.find((ballot) => ballot.humanId === currentHumanId)?.choice;
  const acceptsBallots = vote.status === 'open';
  const authority = vote.rules.eligibleVoters.find((voter) => voter.humanId === vote.authority.humanId);
  const canSettle =
    vote.authority.humanId === currentHumanId &&
    vote.lifecycle === 'open' &&
    (vote.status === 'expired' || (vote.status === 'open' && vote.ballots.length === vote.rules.eligibleVoters.length));
  const canConfirmInvalidation =
    vote.authority.humanId === currentHumanId && vote.lifecycle === 'open' && vote.status === 'invalidated';
  return (
    <article className="binding-vote-card" aria-label={`有约束力的判断 · ${vote.question}`}>
      <header>
        <span>有约束力的路线判断</span>
        <strong>{bindingVoteStatus(vote)}</strong>
      </header>
      <h3>{vote.question}</h3>
      <p className="binding-authority">
        {authority?.displayName ?? 'Roadmap 负责人'}以路线负责人权限开票 · 只生成 Decision，不自动改变路线
      </p>
      <p className="binding-rule">
        {vote.rules.eligibleVoters.length} 位冻结投票人 · {vote.rules.quorumCount} 人参与且同一选项{' '}
        {vote.rules.passCount} 票才通过
      </p>
      <p className="binding-voters">
        投票人 · {vote.rules.eligibleVoters.map((voter) => voter.displayName).join('、')}
      </p>
      <div className="binding-options">
        {vote.options.map((option) => {
          const ballots = vote.ballots.filter(
            (ballot) => ballot.choice.kind === 'option' && ballot.choice.optionId === option.optionId,
          );
          return (
            <button
              key={option.optionId}
              type="button"
              aria-pressed={mine?.kind === 'option' && mine.optionId === option.optionId}
              disabled={!acceptsBallots}
              onClick={() => onCast(vote, { kind: 'option', optionId: option.optionId })}
            >
              <span>{option.label}</span>
              <strong>{ballots.length} 票</strong>
              {ballots.length > 0 && <small>{ballots.map((ballot) => ballot.displayName).join('、')}</small>}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={mine?.kind === 'abstain'}
          disabled={!acceptsBallots}
          onClick={() => onCast(vote, { kind: 'abstain' })}
        >
          <span>弃权</span>
          <strong>{vote.ballots.filter((ballot) => ballot.choice.kind === 'abstain').length} 票</strong>
        </button>
      </div>
      <div className="binding-vote-actions">
        {acceptsBallots && mine && (
          <button type="button" className="quiet-action" onClick={() => onWithdraw(vote)}>
            撤回我的票
          </button>
        )}
        {canSettle && (
          <button type="button" onClick={() => onSettle(vote)}>
            结算为 Decision
          </button>
        )}
        {canConfirmInvalidation && (
          <button type="button" onClick={() => onSettle(vote)}>
            确认本轮失效
          </button>
        )}
      </div>
      {vote.result?.outcome === 'no_decision' && <p className="decision-result">未达到冻结多数，本轮不形成决定。</p>}
      {decision && (
        <section className="decision-card" aria-label={`Decision · ${decision.statement}`}>
          <strong>Decision · {decision.statement}</strong>
          <span>票决与来源已保留；路线未被自动修改。</span>
        </section>
      )}
      {vote.status === 'invalidated' && (
        <p className="decision-result">资格或路线 authority 已变化，本轮失效且不缩小分母。</p>
      )}
    </article>
  );
}

function bindingVoteStatus(vote: CollectiveBindingVoteProjection): string {
  if (vote.status === 'settled') return vote.result?.outcome === 'passed' ? '已形成 Decision' : '未形成决定';
  if (vote.status === 'invalidated') return '已失效';
  if (vote.status === 'expired') return '等待负责人结算';
  return `收集中 · ${vote.ballots.length}/${vote.rules.eligibleVoters.length}`;
}
