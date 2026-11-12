/**
 * #789: keep small microtask batches below React's nested-update limit.
 * #1968: after a bounded slice, return to browser tasks so input and paint can run.
 * A handler may return a replay iterator; it retains the head of the FIFO until done.
 */
type AgentMessageHandler = (msg: unknown) => void | Generator<void, void, unknown>;

export interface AgentMessageCoalescer {
  push: (msg: unknown) => void;
  dispose: () => void;
}

const CHUNK_SIZE = 6;
const TIME_BUDGET_MS = 5;

export function createAgentMessageCoalescer(
  handler: AgentMessageHandler,
  scheduleTask?: (task: () => void) => void,
): AgentMessageCoalescer {
  const queue: unknown[] = [];
  let head = 0;
  let pending: Generator<void, void, unknown> | undefined;
  let flushScheduled = false;
  let disposed = false;
  let sliceStartedAt: number | undefined;
  let channel: MessageChannel | undefined;

  function resume() {
    sliceStartedAt = undefined;
    flush();
  }

  function flush(): void {
    if (disposed) return;
    sliceStartedAt ??= performance.now();
    for (let count = 0; count < CHUNK_SIZE && (pending || head < queue.length); count++) {
      if (pending) {
        if (pending.next().done) pending = undefined;
      } else {
        pending = handler(queue[head++]) ?? undefined;
      }
    }
    if (pending || head < queue.length) {
      if (performance.now() - sliceStartedAt >= TIME_BUDGET_MS) {
        if (scheduleTask) scheduleTask(resume);
        else {
          channel ??= new MessageChannel();
          channel.port1.onmessage = resume;
          channel.port2.postMessage(null);
        }
      } else queueMicrotask(flush);
    } else {
      queue.length = 0;
      head = 0;
      flushScheduled = false;
      sliceStartedAt = undefined;
    }
  }

  return {
    push(msg: unknown): void {
      if (disposed) return;
      queue.push(msg);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
      pending?.return();
      pending = undefined;
      channel?.port1.close();
      channel?.port2.close();
    },
  };
}
