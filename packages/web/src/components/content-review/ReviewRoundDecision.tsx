'use client';
import type { ArtifactReviewAction, ArtifactReviewRound } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ReviewActor } from './ReviewActor';
import { reviewDecisionCopy } from './review-decision.shell-copy';
import { useReviewDraft } from './useReviewDraft';

type DecisionProps = {
  round: ArtifactReviewRound;
  ownerUserId: string;
  canWrite: boolean;
  saving: boolean;
  draftKey: string;
  act: (action: ArtifactReviewAction, round: number) => Promise<boolean>;
  compact?: boolean;
  onDiscuss?: (body?: string) => boolean;
  placement?: 'inbox';
};

export function ReviewRoundDecision(props: DecisionProps) {
  const presentation = useShellPresentation();
  if (props.placement === 'inbox') return <ReviewDecisionForm {...props} compact />;
  return presentation === 'v2' ? <ChatRoundDecision {...props} /> : <ReviewDecisionForm {...props} />;
}

function ChatRoundDecision({ round, canWrite, saving, act, onDiscuss, draftKey }: DecisionProps) {
  const t = useShellCopy(reviewDecisionCopy);
  const saved = useReviewDraft(draftKey);
  const needed = round.state === 'awaiting_human' && !round.attentionRetiredReason;
  return (
    <section aria-label={t.heading} className="flex flex-wrap items-center justify-end gap-2 text-xs">
      {saved.draft.body ? (
        <div className="w-full text-cafe-secondary">
          <p className="line-clamp-3 whitespace-pre-wrap">
            {t.unsent}
            {saved.draft.body}
          </p>
          {onDiscuss ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (onDiscuss(saved.draft.body)) saved.clear();
              }}
            >
              {t.moveToChat}
            </button>
          ) : null}
        </div>
      ) : null}
      {round.decision ? <span>{round.decision.outcome === 'approved' ? t.approved : t.changes}</span> : null}
      {round.decision?.explanation ? <p>{round.decision.explanation}</p> : null}
      {onDiscuss ? (
        <button
          type="button"
          disabled={saving}
          className="rounded-lg border border-cafe-subtle px-3 py-2 font-semibold hover:bg-cafe-surface"
          title={canWrite ? t.discussChanges : t.discussVersion}
          onClick={() => onDiscuss()}
        >
          {canWrite ? t.requestChanges : t.discuss}
        </button>
      ) : null}
      {canWrite && needed ? (
        <button
          type="button"
          disabled={saving}
          className="rounded-lg bg-cafe-accent px-3 py-2 font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-40"
          onClick={() => void act({ kind: 'decide', outcome: 'approved', explanation: '' }, round.number)}
        >
          {t.approve}
        </button>
      ) : null}
    </section>
  );
}

function ReviewDecisionForm({
  round,
  ownerUserId,
  canWrite,
  saving,
  draftKey,
  act,
  compact = false,
  placement,
}: DecisionProps) {
  const localized = useShellCopy(reviewDecisionCopy);
  const inbox = placement === 'inbox';
  const t = inbox ? localized : reviewDecisionCopy.zh;
  const { draft, update, clear, storageError } = useReviewDraft(draftKey);
  const decided = round.state === 'approved' || round.state === 'changes_requested';
  const needed = round.state === 'awaiting_human' && !round.attentionRetiredReason;
  async function submit(action: ArtifactReviewAction) {
    if (await act(action, round.number)) clear(draft);
  }
  return (
    <section
      className={compact ? 'space-y-2' : 'rounded-xl border border-cafe-accent/25 bg-cafe-accent/5 p-4'}
      aria-label={t.heading}
    >
      <h3 className="text-sm font-semibold text-cafe-black">{needed ? t.needed : decided ? t.heading : t.feedback}</h3>
      {round.judgmentRequest ? (
        <div className="mt-3 space-y-2 text-sm leading-6 text-cafe-secondary">
          <ReviewActor actor={round.judgmentRequest.requestedBy} ownerUserId={ownerUserId} />
          <p className="whitespace-pre-wrap break-words">{round.judgmentRequest.summary}</p>
          <p className="whitespace-pre-wrap break-words font-medium text-cafe-black">
            {round.judgmentRequest.judgmentNeeded}
          </p>
        </div>
      ) : null}
      {round.decision ? (
        <div className="mt-3 space-y-2" data-testid="review-round-decision">
          <span className="rounded-full bg-cafe-surface px-3 py-1 text-xs font-semibold text-cafe-accent">
            {round.decision.outcome === 'approved' ? t.approved : t.changes}
          </span>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-cafe-black">
            {round.decision.explanation}
          </p>
          <ReviewActor actor={round.decision.actor} ownerUserId={ownerUserId} />
        </div>
      ) : null}
      {canWrite ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-cafe-secondary">
            {decided ? t.reopenReason : t.reason}
            <textarea
              value={draft.body}
              onChange={(event) => update({ ...draft, body: event.target.value })}
              aria-label={t.explanation}
              disabled={saving}
              maxLength={8000}
              className="mt-2 min-h-20 w-full resize-y rounded-lg border border-cafe-subtle bg-cafe-surface p-3 text-sm text-cafe-black"
              placeholder={decided ? t.reopenPlaceholder : t.placeholder}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {decided ? (
              <button
                type="button"
                disabled={saving || !draft.body.trim()}
                className="rounded-lg border border-cafe-accent/30 px-3 py-2 text-xs font-semibold text-cafe-accent disabled:opacity-40"
                onClick={() => void submit({ kind: 'reopen', explanation: draft.body })}
              >
                {t.reopen}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving || !draft.body.trim()}
                  className="rounded-lg border border-cafe-accent/30 px-3 py-2 text-xs font-semibold text-cafe-accent disabled:opacity-40"
                  onClick={() =>
                    void submit(
                      needed
                        ? { kind: 'decide', outcome: 'changes_requested', explanation: draft.body }
                        : { kind: 'submit_feedback', explanation: draft.body },
                    )
                  }
                >
                  {t.requestChanges}
                </button>
                {needed ? (
                  <button
                    type="button"
                    disabled={saving || (!inbox && !draft.body.trim())}
                    className="rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-40"
                    onClick={() => void submit({ kind: 'decide', outcome: 'approved', explanation: draft.body })}
                  >
                    {t.approve}
                  </button>
                ) : null}
              </>
            )}
          </div>
          {storageError ? (
            <p role="alert" className="text-xs text-cafe-error">
              {t.storageError}
            </p>
          ) : null}
          <p className="text-micro leading-5 text-cafe-secondary">{t.returnNote}</p>
        </div>
      ) : null}
    </section>
  );
}
