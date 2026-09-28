import type { RoutingPreferenceRevisionV1 } from '@cat-cafe/shared';
import { lifecycleLabel, subjectLabel } from './routing-preference-rules';

/**
 * F293 AC-UX3 — existing collaboration rules are read as whole sentences before any
 * editor opens. Every action still goes through the owner/version/renew/retire contract.
 */
export function RoutingPreferenceRuleList({
  heads,
  saving,
  onEdit,
  onRenew,
  onRetire,
}: {
  heads: readonly RoutingPreferenceRevisionV1[];
  saving: boolean;
  onEdit: (head: RoutingPreferenceRevisionV1) => void;
  onRenew: (head: RoutingPreferenceRevisionV1) => void;
  onRetire: (head: RoutingPreferenceRevisionV1) => void;
}) {
  if (heads.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {heads.map((head) => (
        <div key={head.preferenceId} className="rounded-lg border border-cafe-subtle bg-cafe-surface/60 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-cafe-black">{head.rationale}</p>
              <p className="mt-0.5 text-micro text-cafe-muted">
                {head.prefer.map(subjectLabel).join(', ')} 优先于 {head.over.map(subjectLabel).join(', ')} · v
                {head.version}
              </p>
            </div>
            <span className="text-micro font-semibold text-cafe-secondary">{lifecycleLabel(head, Date.now())}</span>
          </div>
          {head.lifecycle === 'active' && (
            <div className="mt-2 flex gap-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => onEdit(head)}
                className="text-micro font-semibold text-cafe-accent hover:underline"
              >
                编辑
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => onRenew(head)}
                className="text-micro font-semibold text-cafe-accent hover:underline"
              >
                续期 30 天
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => onRetire(head)}
                className="text-micro font-semibold text-cafe-secondary hover:underline"
              >
                退休
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
