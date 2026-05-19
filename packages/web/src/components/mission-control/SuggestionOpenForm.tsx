'use client';

import type { ThreadPhase } from '@cat-cafe/shared';

export interface SuggestionCatOption {
  id: string;
  label: string;
}

interface SuggestionOpenFormProps {
  itemId: string;
  catOptions: SuggestionCatOption[];
  catId: string;
  why: string;
  plan: string;
  selectedPhase: ThreadPhase;
  submitting?: boolean;
  onCatIdChange: (value: string) => void;
  onWhyChange: (value: string) => void;
  onPlanChange: (value: string) => void;
  onSubmit: (payload: {
    itemId: string;
    catId: string;
    why: string;
    plan: string;
    requestedPhase: ThreadPhase;
  }) => Promise<void>;
}

export function SuggestionOpenForm({
  itemId,
  catOptions,
  catId,
  why,
  plan,
  selectedPhase,
  submitting,
  onCatIdChange,
  onWhyChange,
  onPlanChange,
  onSubmit,
}: SuggestionOpenFormProps) {
  return (
    <form
      className="mt-4 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!catId || !why.trim() || !plan.trim()) return;
        void onSubmit({
          itemId,
          catId,
          why: why.trim(),
          plan: plan.trim(),
          requestedPhase: selectedPhase,
        });
      }}
    >
      <label className="block text-xs font-medium text-[#5E4C3A]">
        建议领取猫猫
        <select
          value={catId}
          onChange={(event) => onCatIdChange(event.target.value)}
          className="mt-1 w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B]"
          data-testid="mc-suggest-cat"
        >
          {catOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium text-[#5E4C3A]">
        Why
        <textarea
          value={why}
          onChange={(event) => onWhyChange(event.target.value)}
          className="mt-1 h-16 w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B]"
          data-testid="mc-suggest-why"
        />
      </label>
      <label className="block text-xs font-medium text-[#5E4C3A]">
        Plan
        <textarea
          value={plan}
          onChange={(event) => onPlanChange(event.target.value)}
          className="mt-1 h-16 w-full rounded-lg border border-[#E6D7C3] px-2 py-1.5 text-xs text-[#2C241B]"
          data-testid="mc-suggest-plan"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || catOptions.length === 0}
        className="w-full rounded-lg bg-[#1F1A16] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
        data-testid="mc-suggest-submit"
      >
        提交建议领取
      </button>
    </form>
  );
}
