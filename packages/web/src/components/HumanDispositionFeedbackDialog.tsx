'use client';

import type { HumanDispositionFeedbackInput, HumanDispositionReasonCode } from '@cat-cafe/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { HUMAN_DISPOSITION_REASON_COPY } from '../lib/human-disposition-feedback';

const MAX_DETAIL_LENGTH = 500;

export interface HumanDispositionFeedbackDialogProps {
  open: boolean;
  reasonCodes: readonly HumanDispositionReasonCode[];
  subjectLabel: string;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (feedback: HumanDispositionFeedbackInput | undefined) => void;
}

export function HumanDispositionFeedbackDialog({
  open,
  reasonCodes,
  subjectLabel,
  submitting,
  error,
  onCancel,
  onSubmit,
}: HumanDispositionFeedbackDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const firstReasonRef = useRef<HTMLInputElement>(null);
  const [selectedReason, setSelectedReason] = useState<HumanDispositionReasonCode | null>(null);
  const [detail, setDetail] = useState('');

  useEffect(() => {
    if (!open) return;
    setSelectedReason(null);
    setDetail('');
    firstReasonRef.current?.focus();
  }, [open, reasonCodes, subjectLabel]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, open, submitting]);

  if (!open) return null;

  const normalizedDetail = detail.trim();
  const hasValidSelection =
    selectedReason !== null &&
    (selectedReason !== 'other' || (normalizedDetail.length >= 1 && normalizedDetail.length <= MAX_DETAIL_LENGTH));

  const submitFeedback = () => {
    if (!selectedReason || !hasValidSelection || submitting) return;
    onSubmit(
      selectedReason === 'other'
        ? { reasonCode: selectedReason, detail: normalizedDetail }
        : { reasonCode: selectedReason },
    );
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4 py-6 backdrop-blur-sm"
      data-testid="feedback-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-xl border border-cafe bg-cafe-surface shadow-xl"
      >
        <header className="border-b border-cafe px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-cafe-primary">
            为什么不采纳？
          </h2>
          <p id={descriptionId} className="mt-1 text-sm text-cafe-secondary">
            {subjectLabel}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium text-cafe-primary">请选择最贴近的原因</legend>
            {reasonCodes.map((reasonCode, index) => {
              const copy = HUMAN_DISPOSITION_REASON_COPY[reasonCode];
              return (
                <label
                  key={reasonCode}
                  className="flex cursor-pointer gap-3 rounded-lg border border-cafe px-3 py-3 transition-colors hover:bg-cafe-surface-elevated"
                >
                  <input
                    ref={index === 0 ? firstReasonRef : undefined}
                    type="radio"
                    name="human-disposition-reason"
                    value={reasonCode}
                    checked={selectedReason === reasonCode}
                    disabled={submitting}
                    onChange={() => setSelectedReason(reasonCode)}
                    className="mt-0.5 h-4 w-4 accent-[var(--semantic-info)]"
                  />
                  <span>
                    <span className="block text-sm font-medium text-cafe-primary">{copy.label}</span>
                    <span className="mt-0.5 block text-xs leading-5 text-cafe-secondary">{copy.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {selectedReason === 'other' && (
            <div className="mt-4">
              <label htmlFor={`${descriptionId}-detail`} className="text-sm font-medium text-cafe-primary">
                补充原因
              </label>
              <textarea
                id={`${descriptionId}-detail`}
                data-testid="feedback-other-detail"
                value={detail}
                maxLength={MAX_DETAIL_LENGTH}
                disabled={submitting}
                rows={4}
                onChange={(event) => setDetail(event.target.value)}
                placeholder="请用一句话说明"
                className="mt-2 w-full resize-y rounded-lg border border-cafe bg-cafe-surface px-3 py-2 text-sm text-cafe-primary outline-none focus:ring-2 focus:ring-[var(--semantic-info)] disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p
                data-testid="feedback-detail-count"
                className="mt-1 text-right text-xs text-cafe-secondary"
                aria-live="polite"
              >
                {detail.length} / {MAX_DETAIL_LENGTH}
              </p>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-[var(--semantic-critical)]/30 bg-[var(--semantic-critical)]/10 px-3 py-2 text-sm text-[var(--semantic-critical)]"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-cafe px-5 py-4">
          <button
            type="button"
            data-testid="feedback-skip"
            disabled={submitting}
            onClick={() => onSubmit(undefined)}
            className="mr-auto rounded-lg px-3 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
          >
            跳过原因
          </button>
          <button
            type="button"
            data-testid="feedback-cancel"
            disabled={submitting}
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="feedback-submit"
            disabled={!hasValidSelection || submitting}
            onClick={submitFeedback}
            className="rounded-lg bg-semantic-critical px-4 py-2 text-sm font-medium text-[var(--cafe-surface)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '提交中…' : '提交并拒绝'}
          </button>
        </footer>
      </section>
    </div>
  );
}
