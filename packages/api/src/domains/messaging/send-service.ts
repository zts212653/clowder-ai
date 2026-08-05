/**
 * Plugin Messaging — messaging.send orchestration (K-1 / F288, AC-1/AC-2)
 *
 * Order (D-3): validate shape → ledger claim → (permission/state checks) →
 * persist → emit publish event → settle. The claim runs BEFORE handle/
 * permission checks so a retry of an already-settled send returns its receipt
 * even if the handle was revoked or the reply parent expired afterwards —
 * INV-1 receipt identity survives later state changes (the work WAS done).
 *
 * Crash recovery: persist uses a store-level idempotencyKey and emission uses
 * a deterministic eventKey, so a retry converges on the same message and the
 * emit dedupes within the event-log retention window; beyond that window the
 * re-emit carries the same deterministic eventId and consumers dedupe by
 * eventId (at-least-once — the §3.1 contract). Failure before settle releases
 * the claim (retry re-executes).
 *
 * Whisper boundary (v0, F288 doc): whisper sends are NOT event-streamed —
 * fail-closed against leaking restricted content to subscribers.
 */

import { type CatId, catRegistry } from '@cat-cafe/shared';
import type { CanonicalAudience, MessageDraft, MessageProvenance, SendReceipt } from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../cats/services/stores/visibility.js';
import type { PluginCallContext } from './contract/host-types.js';
import { MessagingError } from './contract/host-types.js';
import { validateDraft } from './contract/validate.js';
import { projectEnvelope, readPluginMessageExtra, renderElementsText } from './envelope.js';
import type { HandleService } from './handles.js';
import type { MessagingLedger } from './ledger.js';
import type { AddressHandleRecord, EventLogStore } from './stores/ports.js';
import { clampRetention } from './stores/ports.js';

export interface SendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly handles: HandleService;
  readonly ledger: MessagingLedger;
  readonly events: EventLogStore;
  readonly retentionCount?: number;
  /** Defaults to the runtime CatRegistry; injectable so unit tests do not mutate the global registry. */
  readonly isKnownCatId?: (catId: string) => boolean;
}

/** D-4: validate the declared origin against handle-derived truth; return the stamped provenance. */
function stampProvenance(ctx: PluginCallContext, draft: MessageDraft, handle: AddressHandleRecord): MessageProvenance {
  const declared = draft.payload.provenance.origin;
  if (handle.kind === 'thread_handle') {
    if (declared !== undefined) {
      if (declared.kind !== 'plugin' || declared.instanceId !== ctx.pluginInstanceId) {
        throw new MessagingError('PERMISSION', 'declared origin does not match the calling plugin instance (D-4)');
      }
    }
    return {
      origin: { kind: 'plugin', instanceId: ctx.pluginInstanceId },
      epistemicStatus: draft.payload.provenance.epistemicStatus,
    };
  }
  // connector_binding: external ingress — origin must be external and match the binding
  const binding = handle.connectorBinding;
  if (!binding) {
    throw new MessagingError('PERMISSION', 'connector binding handle has no binding record');
  }
  if (declared !== undefined) {
    if (declared.kind !== 'external' || declared.connectorId !== binding.connectorId) {
      throw new MessagingError('PERMISSION', 'declared origin does not match the connector binding (D-4)');
    }
    if (declared.sourceAddress !== undefined) {
      if (declared.sourceAddress.connectorId !== binding.connectorId) {
        throw new MessagingError('PERMISSION', 'sourceAddress.connectorId does not match the connector binding (D-4)');
      }
      if (declared.sourceAddress.chatId !== binding.externalChatId) {
        throw new MessagingError('PERMISSION', 'sourceAddress.chatId does not match the bound external chat (D-4)');
      }
    }
  }
  return {
    origin: declared ?? { kind: 'external', connectorId: binding.connectorId },
    epistemicStatus: draft.payload.provenance.epistemicStatus,
  };
}

/** Derive canonical audience; whisper targets must sit inside the handle's grant set (§3.1). */
function deriveAudience(
  draft: MessageDraft,
  handle: AddressHandleRecord,
  isKnownCatId: (catId: string) => boolean,
): CanonicalAudience {
  const declared = draft.draftAudience;
  if (declared === undefined || declared.kind === 'public') return { kind: 'public' };
  const allowed = handle.scope.allowedWhisperTargets;
  if (!allowed || allowed.length === 0) {
    throw new MessagingError('PERMISSION', 'handle scope grants no whisper targets');
  }
  const allowedSet = new Set(allowed);
  const outside = declared.targets.filter((t) => !allowedSet.has(t));
  if (outside.length > 0) {
    throw new MessagingError('PERMISSION', 'whisper targets outside the granted set', { outside });
  }
  const unknown = declared.targets.filter((target) => !isKnownCatId(target));
  if (unknown.length > 0) {
    throw new MessagingError('PERMISSION', 'whisper targets must be registered cat ids', { unknown });
  }
  return { kind: 'whisper', targets: declared.targets };
}

export class SendService {
  private readonly deps: SendServiceDeps;
  private readonly retentionCount: number;
  private readonly isKnownCatId: (catId: string) => boolean;

  constructor(deps: SendServiceDeps) {
    this.deps = deps;
    this.retentionCount = clampRetention(deps.retentionCount);
    this.isKnownCatId = deps.isKnownCatId ?? ((catId) => catRegistry.has(catId));
  }

  async send(ctx: PluginCallContext, input: unknown): Promise<SendReceipt> {
    const draft = validateDraft(input);

    // Claim FIRST: settled work must return its receipt regardless of later
    // handle revocation / parent expiry (INV-1 across state changes).
    const claim = await this.deps.ledger.claimSend(ctx.pluginInstanceId, draft.idempotencyKey);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'a send with this idempotencyKey is in flight — retry later');
    }

    try {
      const handle = await this.deps.handles.resolveForSend(ctx.pluginInstanceId, draft.address);
      const provenance = stampProvenance(ctx, draft, handle);
      const audience = deriveAudience(draft, handle, this.isKnownCatId);

      if (draft.replyTo !== undefined) {
        // Fail-closed: the kernel's sanctioned resolver (fetch + eligibility gate,
        // #699) — same-thread only, no deleted/queued/system/briefing parents, and
        // no unrevealed whispers quoted into public replies. The plugin viewer is a
        // pseudo cat identity that never appears in whisperTo, so it sees only
        // public/revealed parents.
        const parent = await resolveVisibleReplyParent(this.deps.messageStore, draft.replyTo, {
          threadId: handle.threadId,
          viewer: { type: 'cat', catId: `plugin:${ctx.pluginInstanceId}` as CatId },
          publicReply: audience.kind !== 'whisper',
        });
        if (!parent) {
          throw new MessagingError('VALIDATION', 'replyTo must reference a visible message in the addressed thread');
        }
      }

      const stored = await this.deps.messageStore.append({
        threadId: handle.threadId,
        userId: handle.userId,
        catId: null,
        content: renderElementsText(draft.payload.elements),
        mentions: [], // v0: plugin sends never trigger @-routing (wake power is K-3a scope)
        timestamp: Date.now(),
        ...(audience.kind === 'whisper'
          ? { visibility: 'whisper' as const, whisperTo: audience.targets as readonly CatId[] }
          : {}),
        ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
        // Store-level idempotency (scoped userId:threadId:key) — D-3 crash recovery:
        // a re-executed send converges on the already-persisted message. Segments are
        // URI-encoded so ':' inside ids cannot forge a foreign instance's key space.
        idempotencyKey: `plugmsg:${encodeURIComponent(ctx.pluginInstanceId)}:${encodeURIComponent(draft.idempotencyKey)}`,
        extra: {
          pluginMessage: {
            instanceId: ctx.pluginInstanceId,
            revision: 1,
            provenance: provenance as unknown as Record<string, unknown>,
            elements: draft.payload.elements as unknown as ReadonlyArray<Record<string, unknown>>,
            ...(draft.sourceEventId !== undefined ? { sourceEventId: draft.sourceEventId } : {}),
            ...(draft.payload.correlationId !== undefined ? { correlationId: draft.payload.correlationId } : {}),
            ...(draft.payload.causationId !== undefined ? { causationId: draft.payload.causationId } : {}),
            appendOps: [],
          },
        },
      });

      const msgHandle = await this.deps.handles.ensureMessageHandle(handle, stored.id);

      let publishSequence: number | undefined;
      if (audience.kind !== 'whisper') {
        const envelope = projectEnvelope(stored);
        if (!envelope) {
          throw new MessagingError('VALIDATION', 'persisted message failed to project to an envelope');
        }
        const emitted = await this.deps.events.append(
          handle.threadId,
          `publish:${stored.id}:1`,
          { eventId: `ev_pub_${stored.id}_1`, type: 'message.publish', envelope },
          this.retentionCount,
        );
        if (emitted.fencedOut || emitted.sequence === undefined) {
          throw new MessagingError('VALIDATION', 'publish event was not assigned a durable sequence');
        }
        publishSequence = emitted.sequence;
        const plugin = readPluginMessageExtra(stored);
        if (!plugin) throw new MessagingError('VALIDATION', 'persisted message lost its canonical plugin payload');
        const marked = await this.deps.messageStore.updatePluginMessage(
          stored.id,
          {
            ...plugin,
            outputRevision: plugin.revision,
            outputSequence: emitted.sequence,
          } as unknown as NonNullable<NonNullable<typeof stored.extra>['pluginMessage']>,
          plugin.revision,
        );
        if (!marked) {
          const current = await this.deps.messageStore.getById(stored.id);
          if (current)
            throw new MessagingError('CONFLICT', 'message revision changed before publish watermark persisted');
          throw new MessagingError('NOT_FOUND', `message ${stored.id} disappeared before publish watermark persisted`);
        }
      }

      const receipt: SendReceipt = {
        messageId: stored.id,
        threadId: handle.threadId,
        revision: 1,
        handle: { kind: 'message' as const, token: msgHandle.handleId },
        ...(publishSequence !== undefined ? { publishSequence } : {}),
      };
      const result = await this.deps.ledger.settleSend(
        ctx.pluginInstanceId,
        draft.idempotencyKey,
        claim.claimToken,
        receipt,
      );
      if (result.status === 'freshly_settled') return receipt;
      if (result.status === 'already_settled') return result.receipt as SendReceipt;
      // rejected — re-claim to get the canonical receipt.
      const canonical = await this.deps.ledger.claimSend(ctx.pluginInstanceId, draft.idempotencyKey);
      if (canonical.status === 'settled') return canonical.receipt;
      throw new MessagingError('RETRYABLE_INFLIGHT', 'send settlement was superseded — retry');
    } catch (err) {
      await this.deps.ledger.releaseSend(ctx.pluginInstanceId, draft.idempotencyKey, claim.claimToken);
      throw err;
    }
  }
}
