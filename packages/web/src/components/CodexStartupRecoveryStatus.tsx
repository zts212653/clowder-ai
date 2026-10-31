'use client';

import { codexAccountCheckCopy } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { codexStartupCopy } from './codex-startup.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

/** Countdown is derived from server timestamps. A stale projection never restarts work. */
export function CodexStartupRecoveryStatus({
  message,
  showRecovered = false,
}: {
  message: ChatMessage;
  showRecovered?: boolean;
}) {
  const state = message.extra?.startupRecovery;
  const t = useShellCopy(codexStartupCopy);
  const language = useShellLanguage();
  const [now, setNow] = useState(Date.now);
  const pending = state?.stage === 'checking' || state?.stage === 'retry_wait';
  const active =
    message.lifecycle?.kind === 'response' ? message.lifecycle.status === 'processing' : message.isStreaming;
  useEffect(() => {
    if (!pending || !active) return;
    setNow(Date.now());
    if (Date.now() >= (state?.deadlineAt ?? 0)) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= (state?.deadlineAt ?? 0)) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [pending, active, state?.deadlineAt]);
  if (!state || (state.stage === 'ready' && (!showRecovered || state.attempt === 1))) return null;
  const interrupted = pending && (!active || now >= state.deadlineAt);
  const content = interrupted
    ? t.interrupted
    : state.stage === 'cancelled'
      ? t.stopped
      : state.stage === 'failed' && state.diagnostics
        ? codexAccountCheckCopy(state.diagnostics, language).summary
        : state.stage === 'ready'
          ? t.recovered(state.attempt)
          : state.stage === 'retry_wait'
            ? t.recovering
            : state.attempt === 1
              ? t.checking
              : t.attempt(state.attempt);
  return (
    <div
      data-testid="codex-startup-recovery"
      role={state.stage === 'failed' ? 'alert' : 'status'}
      className="text-sm leading-relaxed break-words"
    >
      <p className="m-0">{content}</p>
      {state.stage === 'retry_wait' && !interrupted && (
        <p className="m-0 mt-1 text-xs text-cafe-text-muted">
          {t.retry(state.attempt + 1, Math.max(0, Math.ceil(((state.nextRetryAt ?? now) - now) / 1_000)))}
        </p>
      )}
    </div>
  );
}
