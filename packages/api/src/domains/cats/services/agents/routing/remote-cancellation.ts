import type { MessageMetadata, RemoteExecutionRef } from '../../types.js';

/** Per-invocation, synchronous facts; never depend on a post-abort provider yield. */
export function createRemoteCancellationObserver() {
  let dispatched: RemoteExecutionRef | undefined;
  return {
    reset(): void {
      dispatched = undefined;
    },
    onDispatched(execution: RemoteExecutionRef): void {
      dispatched = { ...execution };
    },
    afterAbort(signal: AbortSignal | undefined): MessageMetadata['cancellationDiagnostics'] {
      return signal?.aborted && dispatched
        ? { localWaitCancelled: true, remoteTermination: 'unconfirmed', remoteExecution: dispatched }
        : undefined;
    },
  };
}

export const REMOTE_CANCELLATION_NOTICE = '本地等待已取消；远端任务是否已停止尚未确认，可能仍在运行。';

export function appendRemoteCancellationNotice(content: string): string {
  return content.includes(REMOTE_CANCELLATION_NOTICE)
    ? content
    : `${content}${content ? '\n\n' : ''}${REMOTE_CANCELLATION_NOTICE}`;
}
