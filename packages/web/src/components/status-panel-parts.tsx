'use client';

import { useElapsedTime } from '@/hooks/useElapsedTime';
import type { CatInvocationInfo } from '@/stores/chat-types';
import { SessionIdTag } from './SessionChainInputs';
import { formatDuration } from './status-helpers';

export function CatInvocationTime({ invocation }: { invocation: CatInvocationInfo }) {
  const elapsed = useElapsedTime(invocation.startedAt && !invocation.durationMs ? invocation.startedAt : undefined);

  if (invocation.durationMs != null) {
    return <span className="text-cafe-secondary ml-auto">{formatDuration(invocation.durationMs)}</span>;
  }

  if (invocation.startedAt && elapsed > 0) {
    return <span className="text-conn-emerald-text ml-auto">{formatDuration(elapsed)}</span>;
  }

  return null;
}

export function InvocationIds({ sessionId, invocationId }: { sessionId?: string; invocationId?: string }) {
  return (
    <div className="ml-3.5 mt-1 space-y-0.5">
      {sessionId && (
        <div className="flex items-baseline min-w-0 gap-1">
          <span className="shrink-0 text-micro text-cafe-muted">会话</span>
          <SessionIdTag id={sessionId} />
        </div>
      )}
      {invocationId && (
        <div className="flex items-baseline min-w-0 gap-1">
          <span className="shrink-0 text-micro text-cafe-muted">调用</span>
          <SessionIdTag id={invocationId} label="调用 ID" />
        </div>
      )}
    </div>
  );
}
