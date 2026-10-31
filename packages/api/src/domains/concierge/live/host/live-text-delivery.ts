import type { CodexLiveNativeClient } from '../../../cats/services/agents/providers/CodexLiveRunPort.js';
import { isCodexAppServerRpcError } from '../../../cats/services/agents/providers/codex-app-server-rpc-error.js';
import { companionTextDigest } from '../../../cats/services/stores/companion-submission-state.js';
import { bounded } from '../live-call-async.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { liveMessageDigest, persistLiveUserText } from '../live-transcript.js';
import type { LiveBoundaryContexts } from './live-boundary-contexts.js';

export interface LiveTextDelivery {
  messageId: string;
  delivery: 'accepted' | 'unconfirmed';
}

export async function sendLiveText(input: {
  options: LiveCompanionCallOptions;
  client?: CodexLiveNativeClient;
  nativeThreadId?: string;
  isAvailable(): boolean;
  text: string;
  clientMessageId: string;
  /** A new durable owner input supersedes pending speech before native acknowledgement. */
  onNewOwnerText?(): void;
  onPersisted?(messageId: string): void;
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
  if (!stored.idempotent) input.onNewOwnerText?.();
  if (!stored.idempotent) input.onPersisted?.(stored.message.id);
  const previous = input.deliveries.get(stored.message.id);
  if (previous) return bounded(previous);
  if (!stored.idempotent) input.options.publish(stored.message);
  if (!input.isAvailable()) throw new Error('Live stopped before text delivery');
  const receipt = input.client
    .submitText(input.text, stored.message.id)
    .then(async () => {
      const accepted = await input.options.messageStore.recordCompanionDeliveryAcceptance(stored.message.id, {
        ownerUserId: input.options.binding.userId,
        threadId: input.options.binding.threadId,
        clientMessageId: input.clientMessageId,
        callId: input.options.binding.callId,
        contentDigest: companionTextDigest(input.text),
        acceptedAt: Date.now(),
      });
      if (!accepted) throw new Error('Live text acceptance history unavailable');
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

export async function sendLiveCallText(
  input: Parameters<typeof sendLiveText>[0] & { contexts: LiveBoundaryContexts; onNewOwnerText(): void },
) {
  const actionEpoch = input.text.trim() ? input.contexts.interruptPageAction() : undefined;
  const delivery = await sendLiveText({
    ...input,
    onNewOwnerText: () => {
      input.contexts.ownerVoice.interrupt();
      input.onNewOwnerText();
    },
  });
  if (delivery.delivery === 'accepted' && delivery.newlyPersisted && actionEpoch !== undefined)
    input.contexts.noteAcceptedDirectRequest(delivery.messageId, actionEpoch);
  if (delivery.delivery === 'accepted') input.contexts.onUserTurn();
  return { messageId: delivery.messageId, delivery: delivery.delivery };
}
