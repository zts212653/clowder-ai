import { useState } from 'react';

export function CopyThreadIdMenuItem({ threadId }: { threadId: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const pending = navigator.clipboard?.writeText(threadId);
    if (!pending) {
      setStatus('failed');
      return;
    }
    void pending.then(
      () => setStatus('copied'),
      () => setStatus('failed'),
    );
  };
  return (
    <button
      type="button"
      role="menuitem"
      aria-label="复制 Thread ID"
      onClick={copy}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated"
    >
      <svg
        className="h-3 w-3 shrink-0 text-cafe-muted"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
      </svg>
      <span role="status" aria-live="polite">
        {status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，重试' : '复制 Thread ID'}
      </span>
    </button>
  );
}
