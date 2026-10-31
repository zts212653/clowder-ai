import { useState } from 'react';
import { ApprovalDecisionCard } from '@/components/ApprovalDecisionCard';
import type { AssetCollaborationAction, Suggestion } from './asset-collaboration-store';

interface AssetSuggestionProps {
  suggestion: Suggestion;
  dispatch: (action: AssetCollaborationAction) => void;
  onAccept: () => void;
  onDisagree: () => void;
  disagreementDraft: string;
  acceptBlockedReason?: string;
}

export function AssetSuggestion({
  suggestion,
  dispatch,
  onAccept,
  onDisagree,
  disagreementDraft,
  acceptBlockedReason,
}: AssetSuggestionProps) {
  const [showReason, setShowReason] = useState(false);

  if (suggestion.status !== 'pending') {
    return (
      <section className="mx-auto mb-10 max-w-3xl rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-5 py-4">
        <p className="text-xs font-semibold text-cafe-black">
          {suggestion.status === 'accepted' ? '已接受修改建议' : '已保留分歧'}
        </p>
        {suggestion.decisionReason && (
          <p className="mt-2 text-xs leading-6 text-cafe-secondary">
            <span className="font-semibold">决定理由：</span>
            {suggestion.decisionReason}
          </p>
        )}
        <p className="mt-2 text-micro text-cafe-muted">这项决定已经写入历程，可从右侧回看。</p>
      </section>
    );
  }

  return (
    <section className="mx-auto mb-10 max-w-3xl space-y-4 px-6 sm:px-10" aria-label="待处理修改建议">
      <ApprovalDecisionCard
        testId="asset-change-decision"
        title={suggestion.title}
        actionReason={suggestion.reason}
        recommendation={
          <div>
            <p className="text-micro font-semibold text-cafe-secondary">建议</p>
            <p className="mt-1 text-xs leading-5 text-cafe">{suggestion.recommendation}</p>
          </div>
        }
        currentDecision={
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-cafe-surface-sunken p-3">
              <p className="text-micro font-medium text-cafe-muted">原句</p>
              <p className="mt-1.5 text-xs leading-5 text-cafe-secondary">{suggestion.beforeBody}</p>
            </div>
            <div className="rounded-lg border border-cafe-interactive/25 bg-cafe-surface-elevated p-3">
              <p className="text-micro font-medium text-cafe-interactive">建议正文</p>
              <p className="mt-1.5 text-xs leading-5 text-cafe">{suggestion.proposedBody}</p>
            </div>
          </div>
        }
        details={{ label: '为什么提出', content: suggestion.reason }}
      />

      {showReason && (
        <textarea
          aria-label="说明保留分歧的理由"
          value={disagreementDraft}
          onChange={(event) => dispatch({ type: 'set_disagreement_draft', value: event.currentTarget.value })}
          placeholder="写下为什么暂不采用，后续可以从历程回看…"
          className="min-h-24 w-full resize-y rounded-xl border-2 border-cafe-interactive/25 bg-cafe-surface px-3 py-2 text-xs leading-6 text-cafe outline-none focus:border-cafe-interactive"
        />
      )}

      {acceptBlockedReason && (
        <p className="rounded-lg border border-cafe-warning/30 bg-cafe-warning/10 px-3 py-2 text-xs leading-5 text-cafe-secondary">
          {acceptBlockedReason}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        {showReason ? (
          <button
            type="button"
            onClick={onDisagree}
            disabled={!disagreementDraft.trim()}
            className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium text-cafe-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            确认保留分歧
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowReason(true)}
            className="rounded-lg border border-cafe px-3.5 py-2 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
          >
            保留分歧
          </button>
        )}
        <button
          type="button"
          onClick={onAccept}
          disabled={Boolean(acceptBlockedReason)}
          className="rounded-lg bg-cafe-interactive px-3.5 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          接受并更新
        </button>
      </div>
    </section>
  );
}
