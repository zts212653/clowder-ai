import { appendMessageThroughHost, type IConversationHostAdapter } from './conversation-host-adapter.js';
import type { BridgeDispatchOutcome, BridgeFallbackReason, CloudInvokeDispatchParams } from './types.js';

export interface ConversationHostDispatchDecision {
  readonly outcome: BridgeDispatchOutcome;
  readonly fallback?: {
    readonly reason: BridgeFallbackReason;
    readonly detail: string;
  };
}

function shortMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return String(error).slice(0, 200);
}

export async function dispatchBoundConversationThroughHost(args: {
  readonly adapter: IConversationHostAdapter | null | undefined;
  readonly boundUrl: string | null;
  readonly renderedPrompt: string;
  readonly params: CloudInvokeDispatchParams;
}): Promise<ConversationHostDispatchDecision | null> {
  if (!args.adapter || !args.boundUrl) return null;
  if (!args.params.idempotencyKey) {
    return {
      outcome: { kind: 'fallback', reason: 'missing-idempotency-key' },
      fallback: {
        reason: 'missing-idempotency-key',
        detail: 'Host append requires the persisted source message ID',
      },
    };
  }

  const conversationId = args.boundUrl.replace(/^https:\/\/chatgpt\.com\/c\//, '').replace(/\/$/, '');
  try {
    const receipt = await appendMessageThroughHost(
      args.adapter,
      conversationId,
      args.renderedPrompt,
      args.params.idempotencyKey,
    );
    return {
      outcome: {
        kind: 'sent',
        capturedUrl: args.boundUrl,
        transport: 'host',
        hostMessageId: receipt.hostMessageId,
      },
    };
  } catch (error) {
    const detail = `Host append_message failed: ${shortMessage(error)}`;
    return {
      outcome: { kind: 'error', message: shortMessage(error) },
      fallback: { reason: 'host-append-failed', detail },
    };
  }
}
