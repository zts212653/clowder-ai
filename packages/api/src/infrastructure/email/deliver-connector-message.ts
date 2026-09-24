import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { PersistedQueueDeliveryPort } from '../../domains/cats/services/agents/invocation/PersistedQueueDelivery.js';

/**
 * RFC §5.1/§5.2: an external connector input is not a special delivery mechanism. It builds the same
 * `conversation_input` envelope as a user `send message` and hands it to the one component that owns
 * atomic Message + Queue admission. Queue commit is the durable boundary — producers do not persist a
 * hidden source first and bind it to the Queue afterwards, and they do not carry their own outbox.
 */
export interface ConnectorDeliveryDeps {
  readonly delivery: PersistedQueueDeliveryPort;
}

export interface ConnectorDeliveryInput {
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly content: string;
  readonly source: ConnectorSource;
  /** Stable Queue admission identity; replaying the same key is idempotent, never a second input. */
  readonly idempotencyKey: string;
  readonly extra?: NonNullable<
    import('../../domains/cats/services/stores/ports/MessageStore.js').StoredMessage['extra']
  >;
  readonly contentBlocks?: import('../../domains/cats/services/stores/ports/MessageStore.js').StoredMessage['contentBlocks'];
  readonly priority?: 'urgent' | 'normal';
  /** When the event happened, when that differs from when it is admitted. Defaults to admission. */
  readonly timestamp?: number;
  /** How the Queue row should be filed. Stated by the producer; never inferred from the payload. */
  readonly sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a' | 'issue';
}

export interface ConnectorDeliveryResult {
  readonly messageId: string;
  readonly content: string;
  /** True once the input is durably in the Queue — the only fact a caller may settle an outbox on. */
  readonly admitted: boolean;
}

export async function deliverConnectorMessage(
  deps: ConnectorDeliveryDeps,
  input: ConnectorDeliveryInput,
): Promise<ConnectorDeliveryResult> {
  // A producer that was wired with the wrong deps (e.g. the pre-unification `{ messageStore }`)
  // used to fail as `Cannot read properties of undefined (reading 'deliver')` deep inside a
  // scheduled task, where it reads as a connector outage rather than a composition bug. Name the
  // real defect at the seam so a mis-wired producer is diagnosable from one line of the log.
  if (typeof deps?.delivery?.deliver !== 'function') {
    throw new Error(
      `Connector delivery is mis-wired for source "${input.source}": ConnectorDeliveryDeps.delivery ` +
        'must be a PersistedQueueDeliveryPort. Producers must not pass a MessageStore — atomic ' +
        'Message + Queue admission is the only admission path.',
    );
  }

  const result = await deps.delivery.deliver({
    ownerUserId: input.userId,
    threadId: input.threadId,
    targetCatId: input.catId as CatId,
    idempotencyKey: input.idempotencyKey,
    content: input.content,
    source: input.source,
    ...(input.extra ? { extra: input.extra } : {}),
    ...(input.contentBlocks ? { contentBlocks: input.contentBlocks } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
    ...(input.sourceCategory ? { sourceCategory: input.sourceCategory } : {}),
  });

  // `conflict` and `unavailable` mean the envelope never reached the Queue. Every other state is a
  // durable admission — including an idempotent replay of work already claimed or finished.
  const admitted = result.state !== 'conflict' && result.state !== 'unavailable';

  return { messageId: result.message?.id ?? '', content: input.content, admitted };
}
