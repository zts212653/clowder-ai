'use client';

import { useState } from 'react';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import type { CatInvocationInfo } from '@/stores/chat-types';
import { formatDuration, truncateId } from './status-helpers';

export function CatInvocationTime({ invocation }: { invocation: CatInvocationInfo }) {
  const elapsed = useElapsedTime(invocation.startedAt && !invocation.durationMs ? invocation.startedAt : undefined);

  if (invocation.durationMs != null) {
    return <span className="text-cafe-secondary ml-auto">{formatDuration(invocation.durationMs)}</span>;
  }

  if (invocation.startedAt && elapsed > 0) {
    return <span className="text-green-600 ml-auto">{formatDuration(elapsed)}</span>;
  }

  return null;
}

export function CollapsibleIds({
  sessionId,
  invocationId,
  onCopy,
}: {
  sessionId?: string;
  invocationId?: string;
  onCopy: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="ml-3.5 mt-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] text-cafe-muted hover:text-cafe-secondary transition-colors cursor-pointer select-none"
      >
        {open ? '▾' : '▸'} IDs
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 animate-fade-in">
          {sessionId && (
            <div>
              <span className="text-[10px] text-cafe-muted mr-1">session:</span>
              <button
                className="text-[10px] text-cafe-muted font-mono hover:text-cafe-secondary cursor-pointer transition-colors"
                title={`点击复制: ${sessionId}`}
                onClick={() => onCopy(sessionId)}
              >
                {truncateId(sessionId, 12)}
              </button>
            </div>
          )}
          {invocationId && (
            <div>
              <span className="text-[10px] text-cafe-muted mr-1">invocation:</span>
              <button
                className="text-[10px] text-cafe-muted font-mono hover:text-cafe-secondary cursor-pointer transition-colors"
                title={`点击复制: ${invocationId}`}
                onClick={() => onCopy(invocationId)}
              >
                {truncateId(invocationId, 12)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
