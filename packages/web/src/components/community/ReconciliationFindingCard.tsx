/**
 * F168 Phase D — D5 ReconciliationFindingCard
 *
 * Renders a single reconciliation/SLA finding with evidence source,
 * severity indicator, and action buttons (acknowledge/resolve/waive).
 *
 * Invariants:
 *   INV-D6.3: Show evidence source, not just status badge
 *   INV-D6.4: SVG icons only, no emoji (KD-9)
 */

import { AlertOctagonIcon, HashIcon, ShieldCheckIcon } from './community-icons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FindingWaiver {
  reason: string;
  actor: string;
  evidence: string;
}

type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived';

interface ReconciliationFinding {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  status: FindingStatus;
  waiver: FindingWaiver | null;
  evidenceFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReconciliationFindingCardProps {
  finding: ReconciliationFinding;
  onAction?: (findingId: string, action: 'acknowledge' | 'resolve' | 'waive') => void;
}

// ---------------------------------------------------------------------------
// Severity color map
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, string> = {
  high: 'text-red-400 bg-red-500/10 border-red-500/20',
  warning: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  medium: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  low: 'text-cafe-muted bg-cafe-surface-elevated/30 border-cafe-border/30',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReconciliationFindingCard({ finding, onAction }: ReconciliationFindingCardProps) {
  const severityClasses = SEVERITY_COLORS[finding.severity] ?? SEVERITY_COLORS.low;
  const isActionable = finding.status === 'open' || finding.status === 'acknowledged';

  return (
    <div data-testid={`finding-card-${finding.findingId}`} className={`p-3 rounded-lg border ${severityClasses}`}>
      {/* Header: kind + severity */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <AlertOctagonIcon />
          <span>{finding.findingKind}</span>
        </div>
        <span className="text-micro font-medium uppercase tracking-wider opacity-80">{finding.severity}</span>
      </div>

      {/* Message */}
      <p className="text-xs text-cafe-primary mb-2">{finding.message}</p>

      {/* Evidence fingerprint — INV-D6.3: show evidence source */}
      {finding.evidenceFingerprint && (
        <div
          data-testid={`finding-evidence-${finding.findingId}`}
          className="flex items-center gap-1 text-micro text-cafe-muted mb-2"
        >
          <HashIcon />
          <span>Evidence: {finding.evidenceFingerprint}</span>
        </div>
      )}

      {/* Waiver details — INV-D6.3: show evidence source for waived findings */}
      {finding.status === 'waived' && finding.waiver && (
        <div
          data-testid={`finding-waiver-${finding.findingId}`}
          className="p-2 rounded bg-cafe-accent/10 border border-cafe-accent/20 text-xs mb-2"
        >
          <div className="flex items-center gap-1 font-medium text-cafe-accent mb-0.5">
            <ShieldCheckIcon />
            <span>Waived</span>
          </div>
          <div className="text-cafe-secondary">
            <div>{finding.waiver.reason}</div>
            {finding.waiver.evidence && (
              <div className="text-cafe-muted mt-0.5">Evidence: {finding.waiver.evidence}</div>
            )}
            <div className="text-cafe-muted">Actor: {finding.waiver.actor}</div>
          </div>
        </div>
      )}

      {/* Action buttons — only when actionable AND parent provides a handler */}
      {isActionable && onAction && (
        <div className="flex gap-2 mt-1">
          <button
            data-testid={`finding-ack-btn-${finding.findingId}`}
            type="button"
            onClick={() => onAction?.(finding.findingId, 'acknowledge')}
            className="px-2 py-0.5 text-micro rounded font-medium bg-cafe-surface border border-cafe-border/50 text-cafe-secondary hover:bg-cafe-surface-elevated/50 transition-colors"
          >
            Acknowledge
          </button>
          <button
            data-testid={`finding-resolve-btn-${finding.findingId}`}
            type="button"
            onClick={() => onAction?.(finding.findingId, 'resolve')}
            className="px-2 py-0.5 text-micro rounded font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
          >
            Resolve
          </button>
          <button
            data-testid={`finding-waive-btn-${finding.findingId}`}
            type="button"
            onClick={() => onAction?.(finding.findingId, 'waive')}
            className="px-2 py-0.5 text-micro rounded font-medium bg-cafe-surface border border-cafe-border/50 text-cafe-secondary hover:bg-cafe-surface-elevated/50 transition-colors"
          >
            Waive
          </button>
        </div>
      )}

      {/* Status indicator for non-actionable */}
      {!isActionable && finding.status !== 'waived' && (
        <div className="flex items-center gap-1 text-micro text-cafe-muted mt-1">
          <span className="capitalize">{finding.status}</span>
        </div>
      )}
    </div>
  );
}
