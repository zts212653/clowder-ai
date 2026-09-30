'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copies a conversation link and shows the result for a moment. A result shows only on the link it was
 * for: once the link changes, or the owner goes away, a copy still in flight shows nothing.
 */
export function useCopyChatLink(chatUrl: string | null): { state: CopyState; copy: () => void } {
  const [result, setResult] = useState<{ chatUrl: string; state: 'copied' | 'failed' } | null>(null);
  const operationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatUrlRef = useRef(chatUrl);
  chatUrlRef.current = chatUrl;

  useEffect(
    () => () => {
      operationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    if (!chatUrl) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const isCurrent = () => operationRef.current === operation && chatUrlRef.current === chatUrl;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;

    let state: 'copied' | 'failed';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(chatUrl);
      state = 'copied';
    } catch {
      state = 'failed';
    }

    if (!isCurrent()) return;
    setResult({ chatUrl, state });
    timerRef.current = setTimeout(() => {
      if (!isCurrent()) return;
      timerRef.current = null;
      setResult(null);
    }, 1500);
  }, [chatUrl]);

  return { state: result && result.chatUrl === chatUrl ? result.state : 'idle', copy: () => void copy() };
}
