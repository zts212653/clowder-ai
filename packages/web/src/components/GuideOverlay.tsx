'use client';

import React, { Component, useEffect, useRef, useState } from 'react';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';
import { GuideOverlayCompletion } from './guide-overlay/GuideOverlayCompletion';
import { GuideHUD } from './guide-overlay/GuideOverlayHUD';
import { GuideOverlaySpotlight } from './guide-overlay/GuideOverlaySpotlight';
import { buildGuideTargetSelector, getFocusableElements } from './guide-overlay/helpers';
import { useGuideAutoAdvance } from './guide-overlay/useGuideAutoAdvance';

export { buildGuideTargetSelector, computeHUDPosition, computeShieldPanels } from './guide-overlay/helpers';

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

export function GuideOverlay() {
  const sessionId = useGuideStore((s) => s.session?.sessionId);
  return (
    <GuideErrorBoundary key={sessionId ?? 'idle'}>
      <GuideOverlayInner />
    </GuideErrorBoundary>
  );
}

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
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  const rafRef = useRef<number>(0);
  const lastRectRef = useRef<{ t: number; l: number; w: number; h: number } | null>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    requestAnimationFrame(() => {
      const hud = hudRef.current;
      if (!hud) return;
      const firstFocusable = hud.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
      firstFocusable?.focus();
    });

    return () => {
      const previousFocus = previousFocusRef.current;
      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, []);

  const currentStep =
    session && session.currentStepIndex < session.flow.steps.length
      ? session.flow.steps[session.currentStepIndex]
      : null;
  const isComplete = session?.phase === 'complete';
  const usesHorizontalMedia = !!currentStep?.tipsMetadata && currentStep.tipsMetadata.layout === 'horizontal';
  const lastStep = session ? session.flow.steps[session.flow.steps.length - 1] : null;
  const isAutoConfirmFinish = lastStep?.advance === 'auto-confirm';

  useEffect(() => {
    if (isComplete && isAutoConfirmFinish) exitGuide();
  }, [isComplete, isAutoConfirmFinish, exitGuide]);

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
        }
      } catch (error) {
        console.error('[GuideOverlay] Failed to persist guide cancellation:', error);
      }
    }
    exitGuide();
  };

  useEffect(() => {
    if (!session || !currentStep || isComplete) return;
    lastRectRef.current = null;
    let cancelled = false;
    const selector = buildGuideTargetSelector(currentStep.target);

    const updateRect = () => {
      if (cancelled) return;
      const targetElement = document.querySelector(selector);
      if (targetElement) {
        const rect = targetElement.getBoundingClientRect();
        const previous = lastRectRef.current;
        if (
          !previous ||
          previous.t !== rect.top ||
          previous.l !== rect.left ||
          previous.w !== rect.width ||
          previous.h !== rect.height
        ) {
          lastRectRef.current = { t: rect.top, l: rect.left, w: rect.width, h: rect.height };
          setTargetRect(rect);
        }
        if (session.phase === 'locating') setPhase('active');
      } else {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally watching specific sub-properties to avoid re-measuring on unrelated step changes
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

  useGuideAutoAdvance(currentStep, advanceStep, session?.phase === 'active');

  useEffect(() => {
    if (!session || !currentStep) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        return;
      }
      if (event.key !== 'Tab') return;

      const targetElement = document.querySelector<HTMLElement>(buildGuideTargetSelector(currentStep.target));
      const hud = hudRef.current;
      if (!hud) return;

      const focusableInHud = getFocusableElements(hud);
      const focusableInTarget = getFocusableElements(targetElement);
      const firstHudFocusable = focusableInHud[0];
      const lastHudFocusable = focusableInHud[focusableInHud.length - 1];
      const firstTargetFocusable = focusableInTarget[0];
      const lastTargetFocusable = focusableInTarget[focusableInTarget.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;
      const isInHud = !!activeElement && hud.contains(activeElement);
      const isInTarget = !!activeElement && !!targetElement && targetElement.contains(activeElement);

      if (!isInHud && !isInTarget) {
        event.preventDefault();
        firstHudFocusable?.focus();
        return;
      }

      if (event.shiftKey) {
        if (activeElement === firstHudFocusable) {
          event.preventDefault();
          (lastTargetFocusable ?? lastHudFocusable)?.focus();
        } else if (activeElement === firstTargetFocusable) {
          event.preventDefault();
          lastHudFocusable?.focus();
        }
        return;
      }

      if (activeElement === lastHudFocusable) {
        event.preventDefault();
        (firstTargetFocusable ?? firstHudFocusable)?.focus();
      } else if (activeElement === lastTargetFocusable) {
        event.preventDefault();
        firstHudFocusable?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session, currentStep]);

  const dismissWithReconciliation = () => {
    if (session?.threadId && session.flow.id) {
      apiFetch('/api/guide-actions/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: session.threadId, guideId: session.flow.id }),
      }).catch(() => {});
    }
    exitGuide();
  };

  useEffect(() => {
    if (!currentStep) return;
    const announcement = `步骤 ${(session?.currentStepIndex ?? 0) + 1}/${session?.flow.steps.length ?? 0}: ${currentStep.tips}`;
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => setLiveAnnouncement(announcement), 500);
    return () => {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    };
  }, [currentStep, session?.currentStepIndex, session?.flow.steps.length]);

  if (!session) return null;

  if (isComplete) {
    const handleDismiss = completionFailed ? dismissWithReconciliation : exitGuide;
    return (
      <GuideOverlayCompletion
        completionFailed={completionFailed}
        completionPersisted={completionPersisted}
        flow={session.flow}
        onDismiss={handleDismiss}
      />
    );
  }

  if (!currentStep) return null;

  return (
    <>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>
      <GuideOverlaySpotlight targetRect={targetRect} />
      <GuideHUD
        ref={hudRef}
        step={currentStep}
        stepIndex={session.currentStepIndex}
        totalSteps={session.flow.steps.length}
        phase={session.phase}
        targetRect={targetRect}
        hudSize={hudSize}
        onExit={handleExit}
        onNext={currentStep.advance === 'next' ? advanceStep : undefined}
      />
    </>
  );
}
