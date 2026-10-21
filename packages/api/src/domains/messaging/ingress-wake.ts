import { type CatId, type ConnectorSource, getConnectorDefinition, type MessageContent } from '@cat-cafe/shared';
import { MessagingError } from './contract/host-types.js';
import type { MessagingLedger } from './ledger.js';

/**
 * The Host collaborators an authenticated ingress needs. Offered at the `createMessagingDomain`
 * assembly point; conversation admission and routing stay in the ordinary queue.
 */
export interface MessagingIngressWakeDeps {
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId | undefined,
      userId: string,
      message: string,
      messageId: string,
      contentBlocks?: readonly MessageContent[],
      policy?: unknown,
      sender?: { readonly id: string; readonly name?: string },
    ): Promise<'dispatched' | 'enqueued' | 'full'>;
  };
  readonly socketManager?: { broadcastToRoom(room: string, event: string, data: unknown): void };
}

/** ConnectorRouter.ts connectorSourceIcon, for a connector the repository registry may not know. */
function ingressIcon(definition: ReturnType<typeof getConnectorDefinition>): string {
  if (!definition) return 'message';
  if ('src' in definition.icon && definition.icon.src) return definition.icon.src;
  return definition.icon.type === 'png' ? definition.icon.src : definition.icon.iconId;
}

export function sourceForConnectorIngress(connectorId: string, externalChatId: string): ConnectorSource {
  const definition = getConnectorDefinition(connectorId);
  return {
    connector: connectorId,
    label: definition?.displayName ?? connectorId,
    icon: ingressIcon(definition),
    meta: { externalChatId },
  };
}

/**
 * Publishes the ingress to the thread room in ConnectorRouter's own envelope shape
 * (`connector_message` on `thread:{id}`), so a migrated provider renders identically to the
 * repository-local one it replaces.
 */
export function broadcastIngress(
  deps: MessagingIngressWakeDeps,
  input: {
    readonly threadId: string;
    readonly messageId: string;
    readonly instanceId: string;
    readonly content: string;
    readonly source: ConnectorSource;
    readonly timestamp: number;
  },
): void {
  deps.socketManager?.broadcastToRoom(`thread:${input.threadId}`, 'connector_message', {
    threadId: input.threadId,
    message: {
      id: input.messageId,
      type: 'connector' as const,
      from: { kind: 'plugin' as const, instanceId: input.instanceId },
      content: input.content,
      source: input.source,
      timestamp: input.timestamp,
    },
  });
}

/** The original send routing request, consumed by ordinary conversation admission. */
export interface ResolvedIngress {
  readonly deps: MessagingIngressWakeDeps;
  readonly source: ConnectorSource;
  readonly wake?: 'auto' | { readonly catId: string };
}

/**
 * Runs the Host-side effects of one authenticated ingress under two independent fences: the
 * broadcast is at-most-once (a duplicate doubles a visible bubble; a miss is recovered by any
 * refetch), while the wake is fenced on *durable admission* — it settles only once the trigger
 * accepted the work, so a failure stays retryable instead of becoming silence. See the call site
 * for why the send claim cannot fence either of them.
 */
export async function deliverIngressEffectsOnce(
  ledger: MessagingLedger,
  input: {
    instanceId: string;
    idempotencyKey: string;
    threadId: string;
    userId: string;
    messageId: string;
    content: string;
    contentBlocks?: readonly MessageContent[];
    sender?: { readonly id: string; readonly name?: string };
    timestamp: number;
    ingress: ResolvedIngress;
  },
): Promise<void> {
  const { ingress } = input;
  const receipt = { messageId: input.messageId };
  const { instanceId, idempotencyKey } = input;

  // Broadcast: at-most-once, settled first. Anything other than a fresh settlement means some
  // other attempt owns this bubble. It is never allowed to decide the wake below.
  const wire = await ledger.claimIngressEffect('broadcast', instanceId, idempotencyKey);
  if (wire.status === 'new') {
    const fenced = await ledger.settleIngressEffect('broadcast', instanceId, idempotencyKey, wire.claimToken, receipt);
    if (fenced.status === 'freshly_settled') {
      broadcastIngress(ingress.deps, {
        threadId: input.threadId,
        messageId: input.messageId,
        instanceId: input.instanceId,
        content: input.content,
        source: ingress.source,
        timestamp: input.timestamp,
      });
    }
  }

  if (ingress.wake === undefined) return;

  // Wake: 'settled' is the only status that proves a cat was admitted. 'inflight' is a
  // concurrent attempt owning it — not evidence it landed — so this send must not report
  // success on the strength of someone else's unfinished work.
  const wake = await ledger.claimIngressEffect('wake', instanceId, idempotencyKey);
  if (wake.status === 'settled') return;
  if (wake.status === 'inflight')
    throw new MessagingError('RETRYABLE_INFLIGHT', 'ingress wake is owned by a concurrent attempt — retry');

  try {
    const outcome = await ingress.deps.invokeTrigger.trigger(
      input.threadId,
      ingress.wake === 'auto' ? undefined : (ingress.wake.catId as CatId),
      input.userId,
      input.content,
      input.messageId,
      input.contentBlocks,
      undefined,
      input.sender,
    );
    if (outcome === 'full') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'target cat invocation queue is full — retry');
    }
  } catch (err) {
    // Hand the wake back so the next attempt re-runs it. The trigger's own durable admission
    // key is what keeps that retry from spending a second agent turn.
    await ledger.releaseIngressEffect('wake', instanceId, idempotencyKey, wake.claimToken);
    throw err;
  }

  const settled = await ledger.settleIngressEffect('wake', instanceId, idempotencyKey, wake.claimToken, receipt);
  if (settled.status === 'rejected')
    throw new MessagingError('RETRYABLE_INFLIGHT', 'ingress wake fence was superseded — retry');
}
