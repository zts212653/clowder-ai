'use client';

import React from 'react';
import type { OrchestrationStep, TipsMetadata } from '@/stores/guideStore';
import { buildGuideTargetSelector, computeHUDPosition } from './helpers';

interface GuideHUDProps {
  step: OrchestrationStep;
  stepIndex: number;
  totalSteps: number;
  phase: string;
  targetRect: DOMRect | null;
  hudSize: { width: number; height: number };
  onExit: () => void;
  onNext?: () => void;
}

export const GuideHUD = React.forwardRef<HTMLDivElement, GuideHUDProps>(function GuideHUD(
  { step, stepIndex, totalSteps, phase, targetRect, hudSize, onExit, onNext },
  ref,
) {
  const hasMedia = !!step.tipsMetadata;
  const isHorizontal = step.tipsMetadata?.layout === 'horizontal';
  const widthClass = hasMedia && isHorizontal ? 'w-[480px]' : 'w-[280px]';
  const style = computeHUDPosition(targetRect, hudSize);

  const handleConfirm = () => {
    window.dispatchEvent(new CustomEvent('guide:confirm', { detail: { target: step.target } }));
  };

  return (
    <div
      ref={ref}
      className={`fixed z-[var(--guide-z-hud)] ${widthClass} animate-guide-hud-enter rounded-[var(--guide-radius)] border border-[var(--guide-hud-border)] bg-[var(--guide-hud-bg)] p-4 shadow-xl`}
      style={style}
      role="dialog"
      aria-label="引导面板"
    >
      <div className="mb-3 flex gap-1">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div
            key={i}
            className="h-1.5 flex-1 rounded-full transition-colors"
            style={{
              backgroundColor:
                i < stepIndex
                  ? 'var(--guide-success)'
                  : i === stepIndex
                    ? 'var(--guide-cutout-ring)'
                    : 'var(--guide-hud-border)',
            }}
          />
        ))}
      </div>

      <div className={hasMedia && isHorizontal ? 'mb-3 flex gap-4' : 'mb-3'}>
        <div className={hasMedia && isHorizontal ? 'flex-1' : ''}>
          <p className="text-sm leading-relaxed text-[var(--guide-text-primary)]">{step.tips}</p>
        </div>
        {hasMedia && <TipsMediaBlock metadata={step.tipsMetadata!} />}
      </div>

      {phase === 'locating' && (
        <p className="mb-3 text-xs text-[var(--guide-text-secondary)] animate-pulse">正在定位目标元素...</p>
      )}

      <div className="flex items-center justify-between border-t border-[var(--guide-hud-border)] pt-3">
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg px-3 py-1.5 text-xs text-[var(--guide-text-secondary)] transition hover:bg-black/5"
          aria-label="退出引导"
        >
          退出
        </button>
        {step.advance === 'confirm' && (
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-lg bg-[var(--guide-cutout-ring)] px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
            aria-label="已完成该步骤"
          >
            已完成该步骤
          </button>
        )}
        {onNext && (
          <button
            type="button"
            onClick={onNext}
            className="rounded-lg bg-[var(--guide-cutout-ring)] px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
            aria-label={stepIndex === totalSteps - 1 ? '完成引导' : '下一步'}
          >
            {stepIndex === totalSteps - 1 ? '知道了!' : '下一步'}
          </button>
        )}
      </div>
    </div>
  );
});

function TipsMediaBlock({ metadata }: { metadata: TipsMetadata }) {
  if (metadata.type === 'png' && metadata.src) {
    return (
      <div className="flex-shrink-0">
        <img
          src={metadata.src}
          alt={metadata.alt ?? ''}
          className="max-h-[200px] max-w-[200px] rounded-lg border border-[var(--guide-hud-border)] object-contain"
        />
      </div>
    );
  }

  if (metadata.type === 'card' && metadata.target) {
    return <CardCaptureBlock guideTarget={metadata.target} alt={metadata.alt} />;
  }

  return null;
}

function CardCaptureBlock({ guideTarget, alt }: { guideTarget: string; alt?: string }) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const selector = buildGuideTargetSelector(guideTarget);

    const syncCapture = () => {
      if (cancelled || !containerRef.current) return;
      const source = document.querySelector(selector);
      if (!source) {
        retryTimer = setTimeout(syncCapture, 100);
        return;
      }
      const clone = source.cloneNode(true) as HTMLElement;
      sanitizeCardClone(clone);
      clone.style.pointerEvents = 'none';
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(clone);
    };

    syncCapture();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [guideTarget]);

  return (
    <div
      ref={containerRef}
      className="flex-shrink-0 max-w-[200px] overflow-hidden rounded-lg border border-[var(--guide-hud-border)]"
      role="img"
      aria-label={alt ?? '引导卡片'}
    />
  );
}

function sanitizeCardClone(clone: HTMLElement) {
  clone.setAttribute('inert', '');
  stripGuideIds(clone);

  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('button, a, summary, details')).reverse()) {
    const replacement = document.createElement('span');
    replacement.className = element.className;
    replacement.style.cssText = element.style.cssText;
    replacement.innerHTML = element.innerHTML;
    element.replaceWith(replacement);
  }

  for (const element of Array.from(clone.querySelectorAll<HTMLElement>('input, textarea, select')).reverse()) {
    const replacement = document.createElement('span');
    replacement.className = element.className;
    replacement.style.cssText = element.style.cssText;

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      replacement.textContent = element.value || element.placeholder || '';
    } else if (element instanceof HTMLSelectElement) {
      replacement.textContent = element.selectedOptions[0]?.textContent ?? '';
    }

    element.replaceWith(replacement);
  }

  for (const element of clone.querySelectorAll<HTMLElement>(
    '[tabindex], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  )) {
    element.removeAttribute('tabindex');
    element.setAttribute('contenteditable', 'false');
  }
}

function stripGuideIds(clone: HTMLElement) {
  clone.removeAttribute('data-guide-id');
  for (const element of clone.querySelectorAll<HTMLElement>('[data-guide-id]')) {
    element.removeAttribute('data-guide-id');
  }
}
