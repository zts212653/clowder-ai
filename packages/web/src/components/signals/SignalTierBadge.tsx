import type { SignalTier } from '@cat-cafe/shared';

const tierClassMap: Record<SignalTier, string> = {
  1: 'bg-opus-bg text-opus-dark border-opus-light',
  2: 'bg-codex-bg text-codex-dark border-codex-light',
  3: 'bg-gemini-bg text-gemini-dark border-gemini-light',
  4: 'bg-cafe-surface-elevated text-cafe-secondary border-cafe',
};

interface SignalTierBadgeProps {
  readonly tier: SignalTier;
}

export function SignalTierBadge({ tier }: SignalTierBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tierClassMap[tier]}`}
    >
      Tier {tier}
    </span>
  );
}
