'use client';

import { useEffect, useRef } from 'react';
import type { OrchestrationStep } from '@/stores/guideStore';
import { buildGuideTargetSelector } from './helpers';

export function useGuideAutoAdvance(step: OrchestrationStep | null, advance: () => void, isActive: boolean) {
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

    const attachListener = () => {
      if (cancelled) return;
      const element = document.querySelector(selector);
      if (!element) {
        attachTimer = setTimeout(attachListener, 100);
        return;
      }

      if (advanceType === 'click') {
        const handler = () => scheduleAdvance(300);
        element.addEventListener('click', handler, { once: true, capture: true });
        listenerCleanupRef.current = () => element.removeEventListener('click', handler, { capture: true });
        return;
      }

      if (advanceType === 'input') {
        const handler = () => {
          const value = (element as HTMLInputElement).value;
          if (value && value.trim()) {
            scheduleAdvance(500);
          } else if (delayedAdvanceRef.current) {
            clearTimeout(delayedAdvanceRef.current);
            delayedAdvanceRef.current = null;
          }
        };
        element.addEventListener('input', handler);
        listenerCleanupRef.current = () => element.removeEventListener('input', handler);
        return;
      }

      if (advanceType === 'confirm' || advanceType === 'auto-confirm') {
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
