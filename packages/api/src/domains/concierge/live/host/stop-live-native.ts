import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { bounded } from '../live-call-async.js';

/** End only the native work already bound to this call; never replace its session. */
export async function stopLiveNative(input: {
  client?: CodexLiveNativeClient;
  nativeThreadId?: string;
  startingRealtime: boolean;
  activeTurnId?: string;
  idleWaiters: Set<() => void>;
}): Promise<void> {
  if (!input.client || !input.nativeThreadId) return;
  if (input.startingRealtime)
    await bounded(input.client.request('thread/realtime/stop', { threadId: input.nativeThreadId }));
  if (input.activeTurnId) {
    const idle = new Promise<void>((resolve) => input.idleWaiters.add(resolve));
    await bounded(
      input.client.request('turn/interrupt', { threadId: input.nativeThreadId, turnId: input.activeTurnId }),
    );
    await bounded(idle);
  }
}
