import type { RuntimeInteractionDecision } from '@cat-cafe/shared';

export function RuntimeInteractionDecisionActions({
  decisions,
  disabled,
  disabledFor,
  onSelect,
}: {
  decisions: RuntimeInteractionDecision[];
  disabled: boolean;
  disabledFor?: (decision: RuntimeInteractionDecision) => boolean;
  onSelect: (decision: RuntimeInteractionDecision) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="runtime-interaction-actions">
      {decisions.map((decision) => (
        <button
          key={decision.id}
          type="button"
          disabled={disabled || disabledFor?.(decision)}
          onClick={() => onSelect(decision)}
          className={buttonClass(decision.outcome)}
          title={decision.description}
        >
          {decision.label}
        </button>
      ))}
    </div>
  );
}

function buttonClass(outcome: RuntimeInteractionDecision['outcome']): string {
  const base =
    'min-h-10 rounded-xl border px-3 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
  if (outcome === 'accept') {
    return `${base} border-transparent bg-[var(--semantic-success)] text-[var(--cafe-accent-foreground)]`;
  }
  if (outcome === 'decline') {
    return `${base} border-[var(--semantic-critical)] text-[var(--semantic-critical)]`;
  }
  return `${base} border-cafe bg-cafe-surface text-cafe-muted`;
}
