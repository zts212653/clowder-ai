'use client';

/**
 * F322 original-B: what sits between the chat history and the composer to say "who is running, what is queued, how to
 * stop". The classic interface keeps its two surfaces (the execution bar and the "待处理" queue panel) exactly as they
 * were; the new shell (v2) shows the one execution row instead. One switch, `useShellPresentation()`, the same one the
 * header and the messages already use.
 */
import { ExecutionRow } from '../execution-row/ExecutionRow';
import { QueuePanel } from '../QueuePanel';
import { useShellPresentation } from '../shell/shell-presentation';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

export function ThreadExecutionLayer({ threadId }: { threadId: string }) {
  // Keyed by thread: the row owns pending questions (a force-reset confirmation, a steer confirmation, an open panel).
  // They are about the thread they were asked on and must not follow the footer to another thread.
  if (useShellPresentation() === 'v2') return <ExecutionRow key={threadId} threadId={threadId} />;
  return (
    <>
      <ThreadExecutionBar threadId={threadId} />
      <QueuePanel threadId={threadId} />
    </>
  );
}
