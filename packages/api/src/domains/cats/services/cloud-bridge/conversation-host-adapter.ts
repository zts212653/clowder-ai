export interface HostAppendMessageReceipt {
  readonly hostMessageId: string;
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
