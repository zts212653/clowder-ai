'use client';

import React, { Component, useEffect, useRef, useState } from 'react';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import type { OrchestrationStep } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/** Error boundary — prevents guide overlay crash from taking down the whole app. */
class GuideErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error('[GuideOverlay] Caught error, auto-recovering:', error);
    useGuideStore.getState().exitGuide();
  }
  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/** Wrapped export with error boundary. Key on sessionId forces remount after error recovery. */
export function GuideOverlay() {
  const sessionId = useGuideStore((s) => s.session?.sessionId);
  return (
    <GuideErrorBoundary key={sessionId ?? 'idle'}>
      <GuideOverlayInner />
    </GuideErrorBoundary>
  );
}

/**
 * F155: Guide Overlay (v2 — tag-based engine)
 *
 * - Mask + spotlight on target element (found by data-guide-id)
 * - Tips from flow definition (not hardcoded)
 * - Auto-advance: listen for user interaction with target (click/input/etc.)
 * - HUD: only "退出" + tips + progress dots
 */
function GuideOverlayInner() {
  useGuideEngine();
  const session = useGuideStore((s) => s.session);
  const advanceStep = useGuideStore((s) => s.advanceStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const setPhase = useGuideStore((s) => s.setPhase);
  const completionPersisted = useGuideStore((s) => s.completionPersisted);
  const completionFailed = useGuideStore((s) => s.completionFailed);

  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [hudSize, setHudSize] = useState<{ width: number; height: number }>({ width: 280, height: 160 });
  const rafRef = useRef<number>(0);
  const lastRectRef = useRef<{ t: number; l: number; w: number; h: number } | null>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const hudRef = useRef<HTMLDivElement>(null);

  // A-3: Save focus on mount, restore on unmount, move focus into HUD
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    // Move focus into HUD on next frame (after initial render)
    requestAnimationFrame(() => {
      const hud = hudRef.current;
      if (hud) {
        const firstFocusable = hud.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
        firstFocusable?.focus();
      }
    });
    return () => {
      const prev = previousFocusRef.current;
      if (prev && prev instanceof HTMLElement) {
        prev.focus();
      }
    };
  }, []);

  const currentStep =
    session && session.currentStepIndex < session.flow.steps.length
      ? session.flow.steps[session.currentStepIndex]
      : null;
  const isComplete = session ? session.phase === 'complete' : false;
  const usesHorizontalMedia = !!currentStep?.tipsMetadata && currentStep.tipsMetadata.layout === 'horizontal';
  const handleExit = async () => {
    if (session?.threadId) {
      try {
        const response = await apiFetch('/api/guide-actions/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: session.threadId, guideId: session.flow.id }),
        });
        if (!response.ok) {
          console.error('[GuideOverlay] Failed to persist guide cancellation:', response.status);
          return;
        }
      } catch (error) {
        console.error('[GuideOverlay] Failed to persist guide cancellation:', error);
        return;
      }
    }
    exitGuide();
  };

  // rAF loop: track target element position
  useEffect(() => {
    if (!session || !currentStep || isComplete) return;
    lastRectRef.current = null;
    let cancelled = false;
    const selector = buildGuideTargetSelector(currentStep.target);

    const updateRect = () => {
      if (cancelled) return;
      const el = document.querySelector(selector);
      if (el) {
        const r = el.getBoundingClientRect();
        const prev = lastRectRef.current;
        if (!prev || prev.t !== r.top || prev.l !== r.left || prev.w !== r.width || prev.h !== r.height) {
          lastRectRef.current = { t: r.top, l: r.left, w: r.width, h: r.height };
          setTargetRect(r);
        }
        if (session.phase === 'locating') setPhase('active');
      } else {
        // Target not found yet — keep locating
        if (session.phase !== 'locating') setPhase('locating');
        setTargetRect(null);
      }
      rafRef.current = requestAnimationFrame(updateRect);
    };

    rafRef.current = requestAnimationFrame(updateRect);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
    };
  }, [session, currentStep, isComplete, session?.phase, setPhase]);

  // Measure the rendered HUD so viewport clamping uses real media height/width.
  useEffect(() => {
    const hud = hudRef.current;
    if (!hud || !currentStep || isComplete) return;

    const measure = () => {
      const rect = hud.getBoundingClientRect();
      const nextWidth = Math.round(rect.width) || (usesHorizontalMedia ? 480 : 280);
      const nextHeight = Math.round(rect.height) || 160;
      setHudSize((prev) => {
        if (prev.width === nextWidth && prev.height === nextHeight) return prev;
        return { width: nextWidth, height: nextHeight };
      });
    };

    measure();
    const rafId = requestAnimationFrame(measure);

    if (typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(rafId);
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(hud);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [
    currentStep?.id,
    currentStep?.advance,
    currentStep?.tipsMetadata?.layout,
    currentStep?.tipsMetadata?.src,
    currentStep?.tipsMetadata?.target,
    currentStep?.tipsMetadata?.type,
    isComplete,
    usesHorizontalMedia,
  ]);

  // Auto-advance: listen for interaction with target element
  useAutoAdvance(currentStep, advanceStep, session?.phase === 'active');

  // A-3: Focus trap — Tab cycles between HUD and target element (passthrough).
  // Escape disabled (KD-14): users must click "退出" button.
  useEffect(() => {
    if (!session) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Tab' && currentStep) {
        const targetEl = document.querySelector<HTMLElement>(buildGuideTargetSelector(currentStep.target));
        const hud = hudRef.current;
        if (!hud) return;

        const focusableInHud = getFocusableElements(hud);
        const focusableInTarget = getFocusableElements(targetEl);
        const firstHudFocusable = focusableInHud[0];
        const lastHudFocusable = focusableInHud[focusableInHud.length - 1];
        const firstTargetFocusable = focusableInTarget[0];
        const lastTargetFocusable = focusableInTarget[focusableInTarget.length - 1];
        const activeElement = document.activeElement as HTMLElement | null;
        const isInHud = !!activeElement && hud.contains(activeElement);
        const isInTarget = !!activeElement && !!targetEl && targetEl.contains(activeElement);

        // If focus escaped the trap, pull it back into the HUD.
        if (!isInHud && !isInTarget) {
          e.preventDefault();
          firstHudFocusable?.focus();
          return;
        }

        if (e.shiftKey) {
          if (activeElement === firstHudFocusable) {
            e.preventDefault();
            (lastTargetFocusable ?? lastHudFocusable)?.focus();
          } else if (activeElement === firstTargetFocusable) {
            e.preventDefault();
            lastHudFocusable?.focus();
          }
        } else {
          if (activeElement === lastHudFocusable) {
            e.preventDefault();
            (firstTargetFocusable ?? firstHudFocusable)?.focus();
          } else if (activeElement === lastTargetFocusable) {
            e.preventDefault();
            firstHudFocusable?.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, currentStep]);

  // Reconciliation dismiss: when completion failed, cancel server-side active state before local cleanup
  const dismissWithReconciliation = () => {
    if (session?.threadId && session?.flow.id) {
      apiFetch('/api/guide-actions/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: session.threadId, guideId: session.flow.id }),
      }).catch(() => {}); // best-effort — don't block dismiss
    }
    exitGuide();
  };

  // A-3: Throttled aria-live announcements — separate from HUD to avoid
  // rapid-fire screen reader noise during fast auto-advance transitions.
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!currentStep) return;
    const text = `步骤 ${(session?.currentStepIndex ?? 0) + 1}/${session?.flow.steps.length ?? 0}: ${currentStep.tips}`;
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => setLiveAnnouncement(text), 500);
    return () => {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    };
  }, [currentStep, session?.currentStepIndex, session?.flow.steps.length]);

  if (!session) return null;

  // Completion screen — dismiss blocked until backend confirms persistence
  if (isComplete) {
    const handleDismiss = completionFailed ? dismissWithReconciliation : exitGuide;
    return (
      <div className="fixed inset-0 z-[var(--guide-z-overlay)] flex items-center justify-center">
        <div
          className="fixed inset-0 bg-black/20"
          onClick={completionPersisted || completionFailed ? handleDismiss : undefined}
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
              : `你已经完成了「${session.flow.name}」的全部步骤。`}
          </p>
          <button
            type="button"
            onClick={handleDismiss}
            disabled={!completionPersisted && !completionFailed}
            className="rounded-xl bg-[var(--guide-success)] px-6 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {completionPersisted ? '太好了!' : completionFailed ? '知道了' : '保存中…'}
          </button>
        </div>
      </div>
    );
  }

  if (!currentStep) return null;

  const pad = 8;
  const cutoutStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad,
        left: targetRect.left - pad,
        width: targetRect.width + pad * 2,
        height: targetRect.height + pad * 2,
        borderRadius: 'var(--guide-radius)',
        boxShadow: '0 0 0 9999px var(--guide-overlay-bg)',
        transition: 'all var(--guide-transition-duration) ease-out',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      }
    : {
        position: 'fixed' as const,
        inset: 0,
        backgroundColor: 'var(--guide-overlay-bg)',
        zIndex: 'var(--guide-z-overlay)' as unknown as number,
        pointerEvents: 'none' as const,
      };

  const ringStyle: React.CSSProperties = targetRect
    ? {
        position: 'fixed',
        top: targetRect.top - pad - 2,
        left: targetRect.left - pad - 2,
        width: targetRect.width + pad * 2 + 4,
        height: targetRect.height + pad * 2 + 4,
        borderRadius: 'var(--guide-radius)',
        border: '2px solid var(--guide-cutout-ring)',
        boxShadow: '0 0 12px var(--guide-cutout-shadow), inset 0 0 8px var(--guide-cutout-shadow)',
        transition: 'all var(--guide-transition-duration) ease-out',
        zIndex: 1105,
        pointerEvents: 'none' as const,
        animation: 'var(--guide-breathe-animation)',
      }
    : {};

  const shieldZ = 1101;
  const panels = targetRect ? computeShieldPanels(targetRect, pad) : null;

  return (
    <>
      {/* A-3: Throttled screen reader announcement */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      <div style={cutoutStyle} aria-hidden="true" />
      {targetRect && <div style={ringStyle} aria-hidden="true" />}

      {/* Four-panel click shield with genuine hole over target */}
      {panels ? (
        <>
          <div
            data-guide-click-shield="panel"
            className="fixed top-0 left-0 right-0"
            style={{ height: panels.top.height, zIndex: shieldZ, pointerEvents: 'auto' }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed bottom-0 left-0 right-0"
            style={{ top: panels.bottom.top, zIndex: shieldZ, pointerEvents: 'auto' }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed"
            style={{
              top: panels.left.top,
              left: 0,
              width: panels.left.width,
              height: panels.left.height,
              zIndex: shieldZ,
              pointerEvents: 'auto',
            }}
            aria-hidden="true"
          />
          <div
            data-guide-click-shield="panel"
            className="fixed"
            style={{
              top: panels.right.top,
              left: panels.right.left,
              right: 0,
              height: panels.right.height,
              zIndex: shieldZ,
              pointerEvents: 'auto',
            }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div
          data-guide-click-shield="fallback"
          className="fixed inset-0"
          style={{ zIndex: shieldZ, pointerEvents: 'none' }}
          aria-hidden="true"
        />
      )}

      {/* HUD: tips + exit only */}
      <GuideHUD
        ref={hudRef}
        step={currentStep}
        stepIndex={session.currentStepIndex}
        totalSteps={session.flow.steps.length}
        phase={session.phase}
        targetRect={targetRect}
        hudSize={hudSize}
        onExit={handleExit}
      />
    </>
  );
}

/* ── Auto-advance hook ── */

function useAutoAdvance(step: OrchestrationStep | null, advance: () => void, isActive: boolean) {
  const advanceRef = useRef(advance);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const delayedAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bindingKeyRef = useRef<string | null>(null);
  advanceRef.current = advance;

  useEffect(() => {
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = null;
    if (delayedAdvanceRef.current) {
      clearTimeout(delayedAdvanceRef.current);
      delayedAdvanceRef.current = null;
    }
    bindingKeyRef.current = null;

    if (!step || !isActive) return;

    const target = step.target;
    const advanceType = step.advance;
    const selector = buildGuideTargetSelector(target);
    const bindingKey = `${step.id}:${target}:${advanceType}`;
    bindingKeyRef.current = bindingKey;
    let cancelled = false;
    let attachTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAdvance = (delayMs: number) => {
      if (delayedAdvanceRef.current) {
        clearTimeout(delayedAdvanceRef.current);
      }
      delayedAdvanceRef.current = setTimeout(() => {
        if (bindingKeyRef.current === bindingKey) {
          advanceRef.current();
        }
      }, delayMs);
    };

    // Small delay after step transition to let UI settle
    const attachListener = () => {
      if (cancelled) return;
      const el = document.querySelector(selector);
      if (!el) {
        attachTimer = setTimeout(attachListener, 100);
        return;
      }

      if (advanceType === 'click') {
        const handler = () => {
          // Delay advance to let the click action complete (e.g., open panel)
          scheduleAdvance(300);
        };
        el.addEventListener('click', handler, { once: true, capture: true });
        listenerCleanupRef.current = () => el.removeEventListener('click', handler, { capture: true });
        return;
      }

      if (advanceType === 'input') {
        const handler = () => {
          const val = (el as HTMLInputElement).value;
          if (val && val.trim()) {
            scheduleAdvance(500);
          }
        };
        el.addEventListener('input', handler);
        listenerCleanupRef.current = () => el.removeEventListener('input', handler);
        return;
      }

      if (advanceType === 'confirm') {
        const handler = (event: Event) => {
          const detail = (event as CustomEvent<{ target?: string }>).detail;
          if (detail?.target !== target) return;
          if (bindingKeyRef.current === bindingKey) {
            advanceRef.current();
          }
        };
        window.addEventListener('guide:confirm', handler);
        listenerCleanupRef.current = () => window.removeEventListener('guide:confirm', handler);
        return;
      }

      // 'visible' and 'confirm' auto-advance immediately when target found
      if (advanceType === 'visible') {
        advanceRef.current();
      }
    };
    attachTimer = setTimeout(attachListener, 100);

    return () => {
      cancelled = true;
      if (attachTimer) clearTimeout(attachTimer);
      if (delayedAdvanceRef.current) {
        clearTimeout(delayedAdvanceRef.current);
        delayedAdvanceRef.current = null;
      }
      listenerCleanupRef.current?.();
      listenerCleanupRef.current = null;
      if (bindingKeyRef.current === bindingKey) {
        bindingKeyRef.current = null;
      }
    };
  }, [step?.id, step?.target, step?.advance, isActive]);
}

/* ── Minimal HUD: tips + exit + progress ── */

interface GuideHUDProps {
  step: OrchestrationStep;
  stepIndex: number;
  totalSteps: number;
  phase: string;
  targetRect: DOMRect | null;
  hudSize: { width: number; height: number };
  onExit: () => void;
}

const GuideHUD = React.forwardRef<HTMLDivElement, GuideHUDProps>(function GuideHUD(
  { step, stepIndex, totalSteps, phase, targetRect, hudSize, onExit },
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
      {/* Progress dots */}
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

      {/* Tips content — plain text or with media */}
      <div className={hasMedia && isHorizontal ? 'mb-3 flex gap-4' : 'mb-3'}>
        <div className={hasMedia && isHorizontal ? 'flex-1' : ''}>
          <p className="text-sm leading-relaxed text-[var(--guide-text-primary)]">{step.tips}</p>
        </div>
        {hasMedia && <TipsMediaBlock metadata={step.tipsMetadata!} />}
      </div>

      {/* Locating indicator */}
      {phase === 'locating' && (
        <p className="mb-3 text-xs text-[var(--guide-text-secondary)] animate-pulse">正在定位目标元素...</p>
      )}

      {/* Actions: confirm button (when advance=confirm) + exit */}
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
      </div>
    </div>
  );
});

/* ── Tips Media Block: renders card div or static image ── */

function TipsMediaBlock({ metadata }: { metadata: import('@/stores/guideStore').TipsMetadata }) {
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

  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('button, a, summary, details')).reverse()) {
    const replacement = document.createElement('span');
    replacement.className = el.className;
    replacement.style.cssText = el.style.cssText;
    replacement.innerHTML = el.innerHTML;
    el.replaceWith(replacement);
  }

  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('input, textarea, select')).reverse()) {
    const replacement = document.createElement('span');
    replacement.className = el.className;
    replacement.style.cssText = el.style.cssText;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      replacement.textContent = el.value || el.placeholder || '';
    } else if (el instanceof HTMLSelectElement) {
      replacement.textContent = el.selectedOptions[0]?.textContent ?? '';
    }

    el.replaceWith(replacement);
  }

  for (const el of clone.querySelectorAll<HTMLElement>(
    '[tabindex], [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  )) {
    el.removeAttribute('tabindex');
    el.setAttribute('contenteditable', 'false');
  }
}

function stripGuideIds(clone: HTMLElement) {
  clone.removeAttribute('data-guide-id');
  for (const el of clone.querySelectorAll<HTMLElement>('[data-guide-id]')) {
    el.removeAttribute('data-guide-id');
  }
}

/* ── Position helpers ── */

export function computeHUDPosition(
  targetRect: DOMRect | null,
  hudSize: { width?: number; height?: number } = {},
): React.CSSProperties {
  if (!targetRect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  const hudWidth = hudSize.width ?? 280;
  const hudHeight = hudSize.height ?? 160;
  const gap = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = targetRect.bottom + gap;
  let left = targetRect.left + targetRect.width / 2 - hudWidth / 2;

  if (top + hudHeight > vh - gap) {
    top = targetRect.top - hudHeight - gap;
  }
  left = Math.max(gap, Math.min(left, vw - hudWidth - gap));
  top = Math.max(gap, top);
  return { top, left };
}

/* ── Pure helpers (exported for testing) ── */

export interface ShieldPanels {
  top: { height: number };
  bottom: { top: number };
  left: { top: number; width: number; height: number };
  right: { top: number; left: number; height: number };
}

export function computeShieldPanels(
  rect: { top: number; bottom: number; left: number; right: number; width: number; height: number },
  pad: number,
): ShieldPanels {
  const h = rect.height + pad * 2;
  return {
    top: { height: Math.max(0, rect.top - pad) },
    bottom: { top: rect.bottom + pad },
    left: { top: rect.top - pad, width: Math.max(0, rect.left - pad), height: h },
    right: { top: rect.top - pad, left: rect.right + pad, height: h },
  };
}

export function buildGuideTargetSelector(target: string): string {
  const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(target) : target;
  return `[data-guide-id="${escaped}"]`;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
].join(', ');

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];

  const elements = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('inert'),
  );
  if (root.matches(FOCUSABLE_SELECTOR) && !root.hasAttribute('inert')) {
    elements.unshift(root);
  }
  return elements;
}
