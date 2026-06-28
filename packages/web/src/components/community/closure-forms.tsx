/**
 * F168 Phase D — Closure audit forms (WaiverAuditForm, ReportAuditForm).
 *
 * Extracted from ClosureChecklistCard to stay under 350-line hard limit.
 * INV-D6.2: Waive action always opens audit form; no one-click waive.
 */

import { useCallback, useState } from 'react';
import { CheckCircleIcon, ShieldIcon } from './community-icons';

// ---------------------------------------------------------------------------
// WaiverAuditForm (INV-D6.2)
// ---------------------------------------------------------------------------

export function WaiverAuditForm({
  issueId,
  actor,
  onSubmitted,
}: {
  issueId: string;
  actor: string;
  onSubmitted?: () => void;
}) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = reason.trim().length > 0 && evidence.trim().length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/community-issues/${issueId}/waive-closure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), actor, evidence: evidence.trim() }),
      });
      if (!res.ok) {
        setError(`Request failed (${res.status}). Please try again.`);
        return;
      }
      onSubmitted?.();
    } finally {
      setSubmitting(false);
    }
  }, [issueId, actor, reason, evidence, canSubmit, onSubmitted]);

  return (
    <div
      data-testid="waiver-audit-form"
      className="mt-2 p-3 rounded-md bg-cafe-surface-elevated/30 border border-cafe-border/40"
    >
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-cafe-secondary">
        <ShieldIcon />
        <span>Closure Waiver</span>
      </div>
      <div className="space-y-2">
        <div>
          <label className="block text-micro text-cafe-muted mb-0.5">Reason (required)</label>
          <textarea
            data-testid="waiver-reason-input"
            className="w-full px-2 py-1.5 text-xs rounded bg-cafe-surface border border-cafe-border/50 text-cafe-primary resize-none"
            rows={2}
            value={reason}
            onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)}
            placeholder="Why is reporting not required?"
          />
        </div>
        <div>
          <label className="block text-micro text-cafe-muted mb-0.5">Evidence (required)</label>
          <input
            data-testid="waiver-evidence-input"
            type="text"
            className="w-full px-2 py-1.5 text-xs rounded bg-cafe-surface border border-cafe-border/50 text-cafe-primary"
            value={evidence}
            onInput={(e) => setEvidence((e.target as HTMLInputElement).value)}
            placeholder="Link, commit SHA, or explanation"
          />
        </div>
        {error && (
          <div data-testid="waiver-error" className="text-xs text-red-400">
            {error}
          </div>
        )}
        <button
          data-testid="waiver-submit-btn"
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="px-3 py-1 text-xs rounded font-medium transition-colors bg-cafe-accent/20 text-cafe-accent hover:bg-cafe-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Submit Waiver
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReportAuditForm (matches backend reportSchema)
// Backend requires: { publicCommentUrl: string, actor: string }
// ---------------------------------------------------------------------------

export function ReportAuditForm({
  issueId,
  actor,
  onSubmitted,
}: {
  issueId: string;
  actor: string;
  onSubmitted?: () => void;
}) {
  const [publicCommentUrl, setPublicCommentUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = publicCommentUrl.trim().length > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/community-issues/${issueId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicCommentUrl: publicCommentUrl.trim(), actor }),
      });
      if (!res.ok) {
        setError(`Request failed (${res.status}). Please try again.`);
        return;
      }
      onSubmitted?.();
    } finally {
      setSubmitting(false);
    }
  }, [issueId, actor, publicCommentUrl, canSubmit, onSubmitted]);

  return (
    <div
      data-testid="report-audit-form"
      className="mt-2 p-3 rounded-md bg-cafe-surface-elevated/30 border border-cafe-border/40"
    >
      <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-cafe-secondary">
        <CheckCircleIcon />
        <span>Report Public Comment</span>
      </div>
      <div className="space-y-2">
        <div>
          <label className="block text-micro text-cafe-muted mb-0.5">Public comment URL (required)</label>
          <input
            data-testid="report-url-input"
            type="text"
            className="w-full px-2 py-1.5 text-xs rounded bg-cafe-surface border border-cafe-border/50 text-cafe-primary"
            value={publicCommentUrl}
            onInput={(e) => setPublicCommentUrl((e.target as HTMLInputElement).value)}
            placeholder="https://github.com/owner/repo/issues/N#issuecomment-..."
          />
        </div>
        {error && (
          <div data-testid="report-error" className="text-xs text-red-400">
            {error}
          </div>
        )}
        <button
          data-testid="report-submit-btn"
          type="button"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="px-3 py-1 text-xs rounded font-medium transition-colors bg-cafe-accent/20 text-cafe-accent hover:bg-cafe-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Submit Report
        </button>
      </div>
    </div>
  );
}
