/**
 * F202 Train C1 gap A — Host-derived wake for authenticated connector ingress.
 *
 * WHOSE AUTHORITY THIS IS. F288 freezes for v0 that a plugin speaking in its own voice through a
 * `thread_handle` never gains wake power from its text. External IM ingress is a different address
 * kind with a different authority: a `connector_binding` carries a Host-issued binding whose
 * `connectorId`/`externalChatId` the Host itself verified (D-4, send-service.ts stampProvenance).
 * For that ingress the Host — never the package — derives the target. Nothing here reads a
 * plugin-reported mention or wake target; the only inputs are the verified binding, the relayed
 * text, and Host-owned thread activity.
 *
 * WHY IT LIVES HERE. Today the seven IM providers get this from ConnectorRouter
 * (ConnectorRouter.ts:451-495). Migrating them onto the public SDK routes their ingress through
 * the messaging domain instead, which stamps `mentions: []` for every address kind — so without
 * this, the cutover silently removes @-mention wake from every IM channel. The three-way routing
 * below is ConnectorRouter's, reusing its own `parseMentions` rather than a second copy, so the
 * two paths cannot drift while both exist during the cutover.
 */

import { type CatId, type ConnectorSource, getConnectorDefinition, type MessageContent } from '@cat-cafe/shared';
import { parseMentions } from '../../infrastructure/connectors/mention-parser.js';
import { MessagingError } from './contract/host-types.js';
import type { MessagingLedger } from './ledger.js';

export interface IngressThreadActivity {
  readonly catId: string;
  readonly lastMessageAt: number;
  readonly messageCount: number;
}

/**
 * The Host collaborators an authenticated ingress needs. Offered at the `createMessagingDomain`
 * assembly point; absent means the domain keeps its pre-C1 behaviour (no mentions, no wake).
 */
export interface MessagingIngressWakeDeps {
  readonly invokeTrigger: {
    trigger(
      threadId: string,
      catId: CatId,
      userId: string,
      message: string,
      messageId: string,
      contentBlocks?: readonly MessageContent[],
      policy?: unknown,
      sender?: { readonly id: string; readonly name?: string },
    ): Promise<'dispatched' | 'enqueued' | 'full'>;
  };
  readonly socketManager?: { broadcastToRoom(room: string, event: string, data: unknown): void };
  readonly threadStore?: {
    getParticipantsWithActivity(
      threadId: string,
    ): readonly IngressThreadActivity[] | Promise<readonly IngressThreadActivity[]>;
  };
  readonly getDefaultCatId: () => string;
  readonly getMentionPatterns: () => Map<string, string[]>;
}

/**
 * ConnectorRouter's three-way derivation, in its order (ConnectorRouter.ts:451-463):
 *   1. an explicit @-mention wins;
 *   2. otherwise the thread's most recently active participant — `messageCount > 0` filtered
 *      FIRST, then newest `lastMessageAt`, so a cat that has never spoken cannot win on recency;
 *   3. only a thread with no such activity falls back to the default cat.
 * Collapsing 2 into 3 is a user-visible regression, which is why the filter is not an optimisation.
 */
export async function deriveIngressTarget(
  deps: MessagingIngressWakeDeps,
  threadId: string,
  text: string,
): Promise<CatId> {
  const mention = parseMentions(text, deps.getMentionPatterns(), deps.getDefaultCatId() as CatId);
  if (mention.matched) return mention.targetCatId;
  if (!deps.threadStore) return mention.targetCatId;

  const participants = await deps.threadStore.getParticipantsWithActivity(threadId);
  const lastActive = [...participants]
    .filter((participant) => participant.messageCount > 0)
    .sort((left, right) => right.lastMessageAt - left.lastMessageAt)[0];
  return lastActive ? (lastActive.catId as CatId) : mention.targetCatId;
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
      content: input.content,
      source: input.source,
      timestamp: input.timestamp,
    },
  });
}

/**
 * One authenticated connector ingress after the Host has resolved whose wake it carries. Derived
 * once per send so the delivery step cannot re-derive a different target than the one persisted
 * into `mentions`.
 */
export interface ResolvedIngress {
  readonly deps: MessagingIngressWakeDeps;
  readonly source: ConnectorSource;
  readonly catId?: CatId;
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
  const receipt = { messageId: input.messageId, ...(ingress.catId === undefined ? {} : { catId: ingress.catId }) };
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
        content: input.content,
        source: ingress.source,
        timestamp: input.timestamp,
      });
    }
  }

  if (ingress.catId === undefined) return;

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
      ingress.catId,
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
