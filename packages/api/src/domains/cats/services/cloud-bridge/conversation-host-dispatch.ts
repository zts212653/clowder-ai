import { isCloudBridgeFailureDiagnosticV1 } from '@cat-cafe/shared';
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

function replayTruth(error: unknown): boolean | undefined {
  if (typeof error !== 'object' || error === null || !('idempotentReplay' in error)) return undefined;
  return typeof (error as { idempotentReplay?: unknown }).idempotentReplay === 'boolean'
    ? (error as { idempotentReplay: boolean }).idempotentReplay
    : undefined;
}

function failureDiagnostic(error: unknown) {
  if (typeof error !== 'object' || error === null || !('diagnostic' in error)) return undefined;
  return isCloudBridgeFailureDiagnosticV1(error.diagnostic) ? error.diagnostic : undefined;
}

export async function dispatchBoundConversationThroughHost(args: {
  readonly adapter: IConversationHostAdapter | null | undefined;
  readonly boundUrl: string | null;
  readonly renderedPrompt: string;
  readonly params: CloudInvokeDispatchParams;
}): Promise<ConversationHostDispatchDecision | null> {
  if (!args.adapter || !args.boundUrl) return null;
  if (!args.params.sourceMessageId) {
    return {
      outcome: { kind: 'fallback', reason: 'missing-source-message-id' },
      fallback: {
        reason: 'missing-source-message-id',
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
      args.params.sourceMessageId,
    );
    return {
      outcome: {
        kind: 'sent',
        capturedUrl: args.boundUrl,
        transport: 'host',
        hostMessageId: receipt.hostMessageId,
        ...(receipt.idempotentReplay === undefined ? {} : { idempotentReplay: receipt.idempotentReplay }),
      },
    };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'HOST_UNAVAILABLE'
    ) {
      return null;
    }
    const detail = `Host append_message failed: ${shortMessage(error)}`;
    return {
      outcome: {
        kind: 'error',
        reason: 'host-append-failed',
        message: shortMessage(error),
        detail,
        ...(replayTruth(error) === undefined ? {} : { idempotentReplay: replayTruth(error) }),
        ...(failureDiagnostic(error) === undefined ? {} : { failureDiagnostic: failureDiagnostic(error) }),
      },
      fallback: { reason: 'host-append-failed', detail },
    };
  }
}
