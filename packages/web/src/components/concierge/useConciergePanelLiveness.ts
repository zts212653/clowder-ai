'use client';

import { type RefObject, useEffect, useRef } from 'react';
import { useConciergeStore } from '@/stores/conciergeStore';
import type { ConciergeMessage } from './useConciergeMessages';
import type { ConciergeQueueStatus } from './useConciergeQueue';

export function useConciergePanelLiveness({
  messages,
  invocationStatus,
  queueStatus,
  refresh,
  setInvocationStatus,
  notifyMessage,
  catMsgCountAtSendRef,
  messagesEndRef,
}: {
  messages: ConciergeMessage[];
  invocationStatus: 'idle' | 'pending' | 'in_progress' | 'error';
  queueStatus: ConciergeQueueStatus;
  refresh: () => void;
  setInvocationStatus: (status: 'idle' | 'pending' | 'in_progress' | 'error') => void;
  notifyMessage: () => void;
  catMsgCountAtSendRef: RefObject<number>;
  messagesEndRef: RefObject<HTMLDivElement>;
}) {
  const prevCatMsgCountRef = useRef(-1);
  const historySettledRef = useRef(false);
  const messageCount = messages.length;

  // biome-ignore lint/correctness/useExhaustiveDependencies: message count is the intentional scroll trigger.
  useEffect(() => {
    const element = messagesEndRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messageCount, messagesEndRef]);

  useEffect(() => {
    if (invocationStatus !== 'in_progress') return;
    const catCount = messages.filter((message) => !message.isUser).length;
    if (catCount > (catMsgCountAtSendRef.current ?? 0)) setInvocationStatus('idle');
  }, [messages, invocationStatus, setInvocationStatus, catMsgCountAtSendRef]);

  useEffect(() => {
    const catCount = messages.filter((message) => !message.isUser).length;
    if (prevCatMsgCountRef.current === -1) {
      prevCatMsgCountRef.current = catCount;
      return;
    }
    if (!historySettledRef.current) {
      historySettledRef.current = true;
      prevCatMsgCountRef.current = catCount;
      return;
    }
    if (catCount > prevCatMsgCountRef.current) notifyMessage();
    prevCatMsgCountRef.current = catCount;
  }, [messages, notifyMessage]);

  useEffect(() => {
    if (invocationStatus !== 'in_progress') return;
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [invocationStatus, refresh]);

  useEffect(() => {
    if (invocationStatus !== 'in_progress' || queueStatus.isRunning || !queueStatus.loaded) return;
    let settleId: ReturnType<typeof setTimeout> | undefined;
    const graceId = setTimeout(() => {
      refresh();
      settleId = setTimeout(() => {
        if (useConciergeStore.getState().invocationStatus === 'in_progress') setInvocationStatus('idle');
      }, 1000);
    }, 2000);
    return () => {
      clearTimeout(graceId);
      if (settleId !== undefined) clearTimeout(settleId);
    };
  }, [invocationStatus, queueStatus.isRunning, queueStatus.loaded, refresh, setInvocationStatus]);
}
