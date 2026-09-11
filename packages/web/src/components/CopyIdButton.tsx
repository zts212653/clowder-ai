'use client';

import { useCallback, useRef, useState } from 'react';

/** Compact toolbar action that copies messageId to clipboard. */
export function CopyIdButton({ messageId }: { messageId: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(messageId);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / permission denied) — no-op
    }
  }, [messageId]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded p-1 text-xs text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-secondary cursor-pointer select-none"
      title={messageId}
      aria-label={`复制消息 ID: ${messageId}`}
    >
      {copied ? '✓' : '#'}
    </button>
  );
}
