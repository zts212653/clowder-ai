'use client';

import type { BacklogItem, ThreadPhase } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

interface SuggestionDecisionPanelProps {
  item: BacklogItem;
  selectedPhase: ThreadPhase;
  rejectNote: string;
  submitting?: boolean;
  onChangePhase: (phase: ThreadPhase) => void;
  onChangeRejectNote: (value: string) => void;
  onApprove: (payload: { itemId: string; threadPhase: ThreadPhase }) => Promise<void>;
  onReject: (payload: { itemId: string; note?: string }) => Promise<void>;
}

export function SuggestionDecisionPanel({
  item,
  selectedPhase,
  rejectNote,
  submitting,
  onChangePhase,
  onChangeRejectNote,
  onApprove,
  onReject,
}: SuggestionDecisionPanelProps) {
  const resolveCatName = useCatNameResolver();
  return (
    <div className="mt-4 space-y-2">
      {item.status === 'approved' && (
        <p className="rounded-lg bg-[var(--console-card-bg)] px-2 py-1.5 text-xs text-cafe-secondary shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
          该任务已批准但尚未派发，可手动重试派发。
        </p>
      )}
      <div className="rounded-lg bg-[var(--console-hover-bg)] p-2 text-xs text-cafe-secondary">
        <p>建议猫猫：{item.suggestion?.catId ? resolveCatName(item.suggestion.catId) : '—'}</p>
        <p>Why：{item.suggestion?.why}</p>
        <p>Plan：{item.suggestion?.plan}</p>
      </div>
      <label className="block text-xs font-medium text-cafe-secondary">
        Dispatch Phase
        <select
          value={selectedPhase}
          onChange={(event) => onChangePhase(event.target.value as ThreadPhase)}
          className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-2 py-1.5 text-xs text-cafe"
          data-testid="mc-approve-phase"
        >
          <option value="coding">coding</option>
          <option value="research">research</option>
          <option value="brainstorm">brainstorm</option>
        </select>
      </label>
      <button
        type="button"
        disabled={submitting}
        onClick={() => void onApprove({ itemId: item.id, threadPhase: selectedPhase })}
        className="w-full rounded-lg bg-[var(--cafe-text)] px-3 py-2 text-xs font-semibold text-[var(--cafe-surface)] disabled:opacity-40"
        data-testid="mc-approve-submit"
      >
        {item.status === 'approved' ? '重试派发' : '批准并派发'}
      </button>
      {item.status === 'suggested' && (
        <>
          <label className="block text-xs font-medium text-cafe-secondary">
            驳回备注（可选）
            <input
              value={rejectNote}
              onChange={(event) => onChangeRejectNote(event.target.value)}
              className="mt-1 w-full rounded-[10px] border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-2 py-1.5 text-xs text-cafe"
              data-testid="mc-reject-note"
            />
          </label>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onReject({ itemId: item.id, note: rejectNote.trim() || undefined })}
            className="w-full rounded-lg bg-[var(--console-shell-bg)] px-3 py-2 text-xs font-semibold text-cafe-secondary disabled:opacity-40"
            data-testid="mc-reject-submit"
          >
            拒绝并回到 Open
          </button>
        </>
      )}
    </div>
  );
}
