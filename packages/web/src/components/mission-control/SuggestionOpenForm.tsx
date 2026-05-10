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
      className="mt-4 space-y-3"
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
      <div>
        <p className="text-xs font-semibold text-cafe">建议领取猫猫</p>
        <select
          value={catId}
          onChange={(event) => onCatIdChange(event.target.value)}
          className="console-form-input mt-1.5 text-xs"
          data-testid="mc-suggest-cat"
        >
          {catOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <p className="text-xs font-semibold text-cafe">Why</p>
        <textarea
          value={why}
          onChange={(event) => onWhyChange(event.target.value)}
          className="console-form-input mt-1.5 h-16 w-full text-xs"
          data-testid="mc-suggest-why"
        />
      </div>
      <div>
        <p className="text-xs font-semibold text-cafe">Plan</p>
        <textarea
          value={plan}
          onChange={(event) => onPlanChange(event.target.value)}
          className="console-form-input mt-1.5 h-16 w-full text-xs"
          data-testid="mc-suggest-plan"
        />
      </div>
      <button
        type="submit"
        disabled={submitting || catOptions.length === 0}
        className="console-button-primary w-full disabled:opacity-40"
        data-testid="mc-suggest-submit"
      >
        提交建议领取
      </button>
    </form>
  );
}
