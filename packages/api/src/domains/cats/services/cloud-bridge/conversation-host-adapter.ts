import type { CloudBridgeFailureDiagnosticV1 } from '@clowder-ai/plugin-contract';

export interface HostAppendMessageReceipt {
  readonly hostMessageId: string;
  readonly idempotentReplay?: boolean;
}

/**
 * Narrow host seam for adding one message to an already-known conversation.
 *
 * The snake_case method name intentionally mirrors the capability contract
 * exposed by hosts/plugins. Implementations own authentication and durable
 * idempotency; Clowder AI never substitutes foreground UI automation here.
 */
export interface IConversationHostAdapter {
  append_message(conversationId: string, text: string, idempotencyKey: string): Promise<HostAppendMessageReceipt>;
}

/**
 * A conversation Host failure carrying the code the dispatch maps (frozen h3 (d)): NEEDS_BINDING /
 * BOUND_CONVERSATION_MISMATCH → needs-binding, HOST_UNAVAILABLE → no adapter (nothing was sent),
 * any other code → host-append-failed. `idempotentReplay` and `diagnostic` reach the receipt.
 */
export class ConversationHostError extends Error {
  readonly idempotentReplay?: boolean;
  readonly diagnostic?: CloudBridgeFailureDiagnosticV1;

  constructor(
    readonly code: string,
    message: string,
    details: {
      readonly idempotentReplay?: boolean;
      readonly diagnostic?: CloudBridgeFailureDiagnosticV1;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'ConversationHostError';
    if (details.idempotentReplay !== undefined) this.idempotentReplay = details.idempotentReplay;
    if (details.diagnostic !== undefined) this.diagnostic = details.diagnostic;
  }
}

export class HostAdapterUnavailableError extends Error {
  readonly code = 'HOST_APPEND_UNAVAILABLE';

  constructor() {
    super('Conversation host append_message adapter is unavailable');
    this.name = 'HostAdapterUnavailableError';
  }
}

export class HostAdapterContractError extends Error {
  readonly code = 'HOST_APPEND_INVALID_RECEIPT';

  constructor(message: string) {
    super(message);
    this.name = 'HostAdapterContractError';
  }
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HostAdapterContractError(`${field} must be a non-empty string`);
  }
  return value;
}

export async function appendMessageThroughHost(
  adapter: IConversationHostAdapter | null,
  conversationId: string,
  text: string,
  idempotencyKey: string,
): Promise<HostAppendMessageReceipt> {
  if (!adapter) throw new HostAdapterUnavailableError();
  requireNonEmpty(conversationId, 'conversationId');
  requireNonEmpty(text, 'text');
  requireNonEmpty(idempotencyKey, 'idempotencyKey');

  const receipt = await adapter.append_message(conversationId, text, idempotencyKey);
  requireNonEmpty(receipt?.hostMessageId, 'hostMessageId');
  return receipt;
}
