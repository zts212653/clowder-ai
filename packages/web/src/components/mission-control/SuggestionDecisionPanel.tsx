'use client';

import type { BacklogItem, ThreadPhase } from '@cat-cafe/shared';

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
  return (
    <div className="mt-4 space-y-2">
      {item.status === 'approved' && (
        <p className="rounded-lg border border-[#D4C2AA] bg-[#FCF5E9] px-2 py-1.5 text-xs text-[#7A6146]">
          该任务已批准但尚未派发，可手动重试派发。
        </p>
      )}
      <div className="rounded-lg bg-[#F8F3EA] p-2 text-xs text-[#5F4D3C]">
        <p>建议猫猫：@{item.suggestion?.catId}</p>
        <p>Why：{item.suggestion?.why}</p>
        <p>Plan：{item.suggestion?.plan}</p>
      </div>
      <label className="block text-xs font-medium text-[#5E4C3A]">
        Dispatch Phase
        <select
          value={selectedPhase}
          onChange={(event) => onChangePhase(event.target.value as ThreadPhase)}
          className="mt-1 w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B]"
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
        className="w-full rounded-lg bg-[#1F1A16] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
        data-testid="mc-approve-submit"
      >
        {item.status === 'approved' ? '重试派发' : '批准并派发'}
      </button>
      {item.status === 'suggested' && (
        <>
          <label className="block text-xs font-medium text-[#5E4C3A]">
            驳回备注（可选）
            <input
              value={rejectNote}
              onChange={(event) => onChangeRejectNote(event.target.value)}
              className="mt-1 w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B]"
              data-testid="mc-reject-note"
            />
          </label>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void onReject({ itemId: item.id, note: rejectNote.trim() || undefined })}
            className="w-full rounded-lg border border-[#C9B7A1] px-3 py-2 text-xs font-semibold text-[#6C563F] disabled:opacity-40"
            data-testid="mc-reject-submit"
          >
            拒绝并回到 Open
          </button>
        </>
      )}
    </div>
  );
}
