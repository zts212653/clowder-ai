'use client';

import { useId, useState } from 'react';

export function HarnessGovernanceDecisionActions({
  decidingState,
  onDecide,
}: {
  decidingState?: string;
  onDecide: (action: 'approve' | 'skip' | 'reject', note?: string) => void;
}) {
  const [note, setNote] = useState('');
  const noteId = useId();
  const busy = Boolean(decidingState);
  const trimmedNote = note.trim();

  return (
    <div className="space-y-2" data-testid="f257-governance-decision-actions">
      <label className="block text-micro text-cafe-interactive/65" htmlFor={noteId}>
        审批说明（拒绝时必填）
      </label>
      <textarea
        id={noteId}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        disabled={busy}
        rows={3}
        placeholder="批准/跳过可选；拒绝时说明偏差，系统会带着理由对同一窗口重新评估。"
        className="w-full resize-y rounded-md border border-cafe-subtle/40 bg-cafe-surface px-2 py-1.5 text-micro outline-none focus:border-cafe-primary disabled:opacity-50"
        data-testid="f257-governance-note"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide('approve', trimmedNote)}
          disabled={busy}
          className="rounded-md bg-[var(--semantic-success)] px-3 py-1 text-micro font-medium text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="approve-btn"
        >
          {decidingState === 'approving' ? '...' : '批准并应用'}
        </button>
        <button
          type="button"
          onClick={() => onDecide('skip', trimmedNote)}
          disabled={busy}
          className="rounded-md border border-cafe px-3 py-1 text-micro font-medium hover:bg-cafe-surface disabled:opacity-50"
          data-testid="skip-btn"
        >
          {decidingState === 'skipping' ? '...' : '跳过本次'}
        </button>
        <button
          type="button"
          onClick={() => onDecide('reject', trimmedNote)}
          disabled={busy || !trimmedNote}
          className="rounded-md border border-semantic-critical bg-semantic-critical px-3 py-1 text-micro font-medium text-[var(--cafe-surface)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:border-cafe disabled:bg-[var(--cafe-border)] disabled:text-cafe-secondary disabled:opacity-100"
          data-testid="reject-btn"
        >
          {decidingState === 'rejecting' ? '...' : '拒绝并重评'}
        </button>
      </div>
    </div>
  );
}
