import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { isCodexAppServerRpcError } from '../../../cats/services/agents/providers/codex-app-server-rpc-error.js';
import { bounded } from '../live-call-async.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { liveMessageDigest, persistLiveUserText } from '../live-transcript.js';

export async function sendLiveText(input: {
  options: LiveCompanionCallOptions;
  client?: CodexLiveNativeClient;
  nativeThreadId?: string;
  isAvailable(): boolean;
  text: string;
  clientMessageId: string;
  deliveries: Map<string, Promise<{ messageId: string; delivery: 'accepted' }>>;
  exposedMessages: Map<string, { kind: 'text' | 'voice'; digest: string }>;
}): Promise<{ messageId: string; delivery: 'accepted' | 'unconfirmed'; newlyPersisted?: boolean }> {
  if (!input.isAvailable() || !input.client || !input.nativeThreadId) throw new Error('Live call unavailable');
  const stored = await persistLiveUserText(
    input.options.messageStore,
    input.options.binding,
    input.text,
    input.clientMessageId,
  );
  const previous = input.deliveries.get(stored.message.id);
  if (previous) return bounded(previous);
  if (!stored.idempotent) input.options.publish(stored.message);
  if (!input.isAvailable()) throw new Error('Live stopped before text delivery');
  const receipt = input.client
    .submitText(input.text, stored.message.id)
    .then(() => {
      input.exposedMessages.set(stored.message.id, { kind: 'text', digest: liveMessageDigest(stored.message) });
      return { messageId: stored.message.id, delivery: 'accepted' as const };
    })
    .catch((error: unknown) => {
      // Only a native rejection permits retry; ambiguous transport keeps the receipt.
      if (isCodexAppServerRpcError(error) && input.deliveries.get(stored.message.id) === receipt)
        input.deliveries.delete(stored.message.id);
      throw error;
    });
  input.deliveries.set(stored.message.id, receipt);
  return { ...(await bounded(receipt)), newlyPersisted: !stored.idempotent };
}
