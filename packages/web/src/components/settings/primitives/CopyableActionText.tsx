'use client';

import { useState } from 'react';

export function CopyableActionText({
  text,
  copyText,
  className,
}: {
  readonly text: string;
  readonly copyText?: string;
  readonly className?: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    if (copyText === undefined) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="space-y-2">
      <pre className={className}>{text}</pre>
      {copyText !== undefined && (
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded-lg border border-cafe-border px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:bg-cafe-surface-sunken"
          aria-label="复制操作结果"
        >
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请重试' : '复制'}
        </button>
      )}
    </div>
  );
}
