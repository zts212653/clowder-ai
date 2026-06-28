/**
 * F168 Phase D — D5 ClosureChecklistCard
 *
 * Renders a closure checklist for community issues: blockers, waiver audit trail,
 * and actions (mark-reported, waive-closure, close).
 *
 * Invariants:
 *   INV-D6.1: Close action disabled until checklist ready or waiver exists
 *   INV-D6.2: Waive action always opens audit form; no one-click waive
 *   INV-D6.3: Show evidence source, not just green/red badge
 *   INV-D6.4: SVG icons only, no emoji (KD-9)
 */

import { useState } from 'react';
import { ReportAuditForm, WaiverAuditForm } from './closure-forms';
import { AlertTriangleIcon, CheckCircleIcon, FileTextIcon, ShieldIcon } from './community-icons';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClosureChecklistBlocker {
  readonly kind: 'fixed-not-reported' | 'not-in-closeable-state';
  readonly detail: string;
}

interface ClosureChecklist {
  readonly readyToClose: boolean;
  readonly blockers: readonly ClosureChecklistBlocker[];
  readonly waiverPresent: boolean;
}

interface CommunityClosureWaiver {
  reason: string;
  actor: string;
  evidence: string;
}

export interface ClosureChecklistCardProps {
  issueId: string;
  checklist: ClosureChecklist;
  waiver: CommunityClosureWaiver | null;
  /** Identity of the acting cat/user — required by backend closure endpoints */
  actor: string;
  onAction?: (action: 'report' | 'waive' | 'close') => void;
  /** Test-only: force waiver form open without click */
  _forceShowWaiverForm?: boolean;
  /** Test-only: force report form open without click */
  _forceShowReportForm?: boolean;
}

// ---------------------------------------------------------------------------
// ClosureChecklistCard
// ---------------------------------------------------------------------------

export function ClosureChecklistCard({
  issueId,
  checklist,
  waiver,
  actor,
  onAction,
  _forceShowWaiverForm,
  _forceShowReportForm,
}: ClosureChecklistCardProps) {
  const [showWaiverForm, setShowWaiverForm] = useState(_forceShowWaiverForm ?? false);
  const [showReportForm, setShowReportForm] = useState(_forceShowReportForm ?? false);

  // INV-D6.1: Close enabled when ready OR waiver present
  const canClose = checklist.readyToClose || checklist.waiverPresent;

  return (
    <div
      data-testid={`closure-checklist-${issueId}`}
      className="p-3 rounded-lg bg-cafe-surface-elevated/20 border border-cafe-border/30"
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-cafe-secondary">
        <FileTextIcon />
        <span>Closure Checklist</span>
      </div>

      {/* Blockers list — INV-D6.3: evidence source, not just badge */}
      {checklist.blockers.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {checklist.blockers.map((blocker) => (
            <div
              key={blocker.kind}
              data-testid={`blocker-${blocker.kind}`}
              className="flex items-start gap-1.5 text-xs"
            >
              <span className="mt-0.5 text-amber-400 shrink-0">
                <AlertTriangleIcon />
              </span>
              <span className="text-cafe-primary">{blocker.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* Ready indicator */}
      {checklist.readyToClose && checklist.blockers.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400 mb-3">
          <CheckCircleIcon />
          <span>All checks passed — ready to close</span>
        </div>
      )}

      {/* Waiver audit trail — INV-D6.3: show evidence source */}
      {waiver && (
        <div
          data-testid="waiver-audit-trail"
          className="p-2 mb-3 rounded bg-cafe-accent/10 border border-cafe-accent/20 text-xs"
        >
          <div className="flex items-center gap-1 font-medium text-cafe-accent mb-1">
            <ShieldIcon />
            <span>Waiver Active</span>
          </div>
          <div className="text-cafe-secondary">
            <div>{waiver.reason}</div>
            <div className="text-cafe-muted mt-0.5">Evidence: {waiver.evidence}</div>
            <div className="text-cafe-muted">Actor: {waiver.actor}</div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        {/* Mark as Reported — opens form, parallel to waive pattern */}
        {checklist.blockers.some((b) => b.kind === 'fixed-not-reported') && (
          <button
            data-testid="mark-reported-btn"
            type="button"
            onClick={() => setShowReportForm(true)}
            className="px-3 py-1 text-xs rounded font-medium bg-cafe-surface border border-cafe-border/50 text-cafe-secondary hover:bg-cafe-surface-elevated/50 transition-colors"
          >
            Mark as Reported
          </button>
        )}

        {/* Waive Closure — INV-D6.2: opens form, no one-click waive.
            Hidden when issue is not-in-closeable-state (waiving doesn't apply,
            backend would reject). */}
        {!checklist.waiverPresent && !checklist.blockers.some((b) => b.kind === 'not-in-closeable-state') && (
          <button
            data-testid="waive-closure-btn"
            type="button"
            onClick={() => setShowWaiverForm(true)}
            className="px-3 py-1 text-xs rounded font-medium bg-cafe-surface border border-cafe-border/50 text-cafe-secondary hover:bg-cafe-surface-elevated/50 transition-colors"
          >
            Waive Closure
          </button>
        )}

        {/* Close — INV-D6.1: disabled until ready or waiver */}
        <button
          data-testid="close-issue-btn"
          type="button"
          disabled={!canClose}
          onClick={() => onAction?.('close')}
          className="px-3 py-1 text-xs rounded font-medium transition-colors bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Close Issue
        </button>
      </div>

      {/* Inline report form — parallel to waiver form pattern */}
      {showReportForm && checklist.blockers.some((b) => b.kind === 'fixed-not-reported') && (
        <ReportAuditForm
          issueId={issueId}
          actor={actor}
          onSubmitted={() => {
            setShowReportForm(false);
            onAction?.('report');
          }}
        />
      )}

      {/* Inline waiver form — INV-D6.2 */}
      {showWaiverForm && !checklist.waiverPresent && (
        <WaiverAuditForm
          issueId={issueId}
          actor={actor}
          onSubmitted={() => {
            setShowWaiverForm(false);
            onAction?.('waive');
          }}
        />
      )}
    </div>
  );
}
