import type { F317MeetingSubscription } from './f317-meeting-source.js';

interface WakeSubscription {
  close(): void;
}

interface WakeSource {
  subscribe(
    threadId: string,
    callbacks: {
      onTranscript(): void | Promise<void>;
      onStopped?(): void | Promise<void>;
      onError?(error: Error): void | Promise<void>;
    },
  ): Promise<WakeSubscription>;
}

export async function startF317MeetingFeed(input: {
  readonly threadId: string;
  readonly subscription: F317MeetingSubscription;
  /** Existing F195 SSE subscriber is a wake hint; the JSONL artifact is the source of truth. */
  readonly wakeSource: WakeSource;
  readonly pollIntervalMs?: number;
  readonly onStopped?: () => void | Promise<void>;
  readonly onError?: (error: Error) => void | Promise<void>;
}): Promise<{ close(): void }> {
  const initial = await input.subscription.refresh();
  if (initial.state !== 'ready') {
    input.subscription.close();
    throw new Error(`meeting_source_not_ready:${initial.state}`);
  }

  let active = true;
  let wake: WakeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (!active) return;
    active = false;
    if (timer) clearInterval(timer);
    wake?.close();
    input.subscription.close();
  };
  const refresh = async () => {
    if (!active) return;
    try {
      const result = await input.subscription.refresh();
      if (!active || result.state === 'ready' || result.state === 'closed') return;
      close();
      if (result.state === 'stopped' || result.state === 'binding_mismatch') await input.onStopped?.();
      else await input.onError?.(new Error(`meeting_source_${result.state}`));
    } catch (error) {
      close();
      await input.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  try {
    wake = await input.wakeSource.subscribe(input.threadId, {
      onTranscript: refresh,
      onStopped: async () => {
        if (!active) return;
        close();
        await input.onStopped?.();
      },
      onError: async (error) => {
        if (!active) return;
        close();
        await input.onError?.(error);
      },
    });
    if (!active) {
      wake.close();
      return { close };
    }
    await refresh(); // Catches lines written between the first replay and SSE attachment.
    if (!active) return { close };
    timer = setInterval(
      () => {
        void refresh();
      },
      Math.max(100, input.pollIntervalMs ?? 2_000),
    );
    timer.unref?.();
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
