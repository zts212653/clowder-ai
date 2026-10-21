'use client';
import type { ArtifactReviewView } from '@cat-cafe/shared';
import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { apiFetch } from '@/utils/api-client';
import { workSubmissionRecoveryCopy } from './work-submission-recovery.shell-copy';

export function WorkSubmissionRecovery({
  view,
  onRecovered,
}: {
  view: ArtifactReviewView;
  onRecovered: () => Promise<void>;
}) {
  const t = useShellCopy(workSubmissionRecoveryCopy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationId] = useState(() => crypto.randomUUID());
  const pending = view.pendingSubmission;
  if (!pending) return null;
  const resolve = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/works/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: view.review.task.threadId,
          command: {
            action: 'resolve-review-submission',
            reviewId: view.review.reviewId,
            sourceRound: pending.sourceRound,
            expectedReviewRevision: pending.expectedReviewRevision,
            pendingOperationId: pending.operationId,
            operationId,
          },
        }),
      });
      if (!response.ok) throw new Error(t.failed);
      await onRecovered();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-lg border border-cafe-subtle p-3 text-sm" aria-label={t.title}>
      <p>{t.explanation}</p>
      <button type="button" className="mt-2 text-cafe-accent" disabled={busy} onClick={() => void resolve()}>
        {busy ? t.checking : t.resolve}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
