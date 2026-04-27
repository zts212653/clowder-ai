'use client';

import type { OrchestrationFlow } from '@/stores/guideStore';

interface GuideOverlayCompletionProps {
  completionFailed: boolean;
  completionPersisted: boolean;
  flow: OrchestrationFlow;
  onDismiss: () => void;
}

export function GuideOverlayCompletion({
  completionFailed,
  completionPersisted,
  flow,
  onDismiss,
}: GuideOverlayCompletionProps) {
  return (
    <div className="fixed inset-0 z-[var(--guide-z-overlay)] flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/20"
        onClick={completionPersisted || completionFailed ? onDismiss : undefined}
      />
      <div className="relative z-10 rounded-2xl border border-[var(--guide-hud-border)] bg-[var(--guide-hud-bg)] p-8 text-center shadow-2xl">
        <div className="mb-4 flex justify-center">
          {completionFailed ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-10 w-10 text-amber-500"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-10 w-10 text-cafe-secondary">
              <ellipse cx="7.5" cy="14" rx="3" ry="2.5" fill="currentColor" />
              <ellipse cx="16.5" cy="14" rx="3" ry="2.5" fill="currentColor" />
              <ellipse cx="12" cy="19" rx="2.5" ry="2" fill="currentColor" />
              <ellipse cx="5" cy="9" rx="2" ry="2.5" fill="currentColor" />
              <ellipse cx="19" cy="9" rx="2" ry="2.5" fill="currentColor" />
            </svg>
          )}
        </div>
        <h3 className="mb-2 text-lg font-bold text-[var(--guide-text-primary)]">
          {completionFailed ? '保存失败' : '引导完成!'}
        </h3>
        <p className="mb-4 text-sm text-[var(--guide-text-secondary)]">
          {completionFailed
            ? '引导已完成但保存失败，下次打开时可能需要重新引导。'
            : `你已经完成了「${flow.name}」的全部步骤。`}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          disabled={!completionPersisted && !completionFailed}
          className="rounded-xl bg-[var(--guide-success)] px-6 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {completionPersisted ? '太好了!' : completionFailed ? '知道了' : '保存中…'}
        </button>
      </div>
    </div>
  );
}
