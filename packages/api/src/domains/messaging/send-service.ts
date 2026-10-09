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

import { randomUUID } from 'node:crypto';
import { type CatId, type ConnectorSource, catRegistry, type MessageContent } from '@cat-cafe/shared';
import type { CanonicalAudience, MessageDraft, MessageProvenance, SendReceipt } from '@clowder-ai/plugin-contract';
import {
  type AppendMessageInput,
  generateSortableId,
  type IMessageStore,
} from '../cats/services/stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../cats/services/stores/visibility.js';
import type { PluginCallContext } from './contract/host-types.js';
import { MessagingError } from './contract/host-types.js';
import { validateDraft } from './contract/validate.js';
import { projectEnvelope, readPluginMessageExtra, renderElementsText } from './envelope.js';
import type { HandleService } from './handles.js';
import {
  deliverIngressEffectsOnce,
  deriveIngressTarget,
  type MessagingIngressWakeDeps,
  type ResolvedIngress,
  sourceForConnectorIngress,
} from './ingress-wake.js';

import type { MessagingLedger } from './ledger.js';
import { replaceLegacyMediaReferences } from './legacy-media.js';
import type { PendingMediaPublication } from './media-pending-publication.js';
import type { MediaReferenceAuthority } from './media-reference-authority.js';
import { type MediaSourceResolver, mediaStageKey, type StagedMediaSend } from './media-staging.js';
import type { AddressHandleRecord, EventLogStore } from './stores/ports.js';

import { clampRetention } from './stores/ports.js';

export interface SendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly handles: HandleService;
  readonly ledger: MessagingLedger;
  readonly events: EventLogStore;
  readonly mediaReferences?: Pick<MediaReferenceAuthority, 'assertCanReference'>;
  readonly mediaPending?: PendingMediaPublication;
  readonly mediaSources?: MediaSourceResolver;
  readonly retentionCount?: number;
  /** Defaults to the runtime CatRegistry; injectable so unit tests do not mutate the global registry. */
  readonly isKnownCatId?: (catId: string) => boolean;
  /** F202 C1 gap A. Absent means authenticated ingress keeps the pre-C1 behaviour: no wake. */
  readonly ingressWake?: MessagingIngressWakeDeps;
  /** Fire-and-forget subscriber delivery after a durable public event is appended. */
  readonly onPublished?: (threadId: string) => void;
}

export interface HostSendOptions {
  readonly source: ConnectorSource;
  readonly contentBlocks?: readonly MessageContent[];
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly wake?: 'auto' | { readonly catId: string };
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

  async send(ctx: PluginCallContext, input: unknown, hostOptions?: HostSendOptions): Promise<SendReceipt> {
    const validated = validateDraft(input);
    const draft: MessageDraft = {
      ...validated,
      payload: { ...validated.payload, elements: replaceLegacyMediaReferences(validated.payload.elements) },
    };

    // Claim FIRST: settled work must return its receipt regardless of later
    // handle revocation / parent expiry (INV-1 across state changes).
    const claim = await this.deps.ledger.claimSend(ctx.pluginInstanceId, draft.idempotencyKey);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'a send with this idempotencyKey is in flight — retry later');
    }

    try {
      // A staged send has already accepted the request. Replays keep its exact receipt
      // even if the address handle was revoked before the ledger claim settled.
      if (draft.sourceEventId && this.deps.mediaPending) {
        const staged = await this.deps.mediaPending.get(
          mediaStageKey(ctx.pluginInstanceId, draft.sourceEventId, draft.idempotencyKey),
        );
        if (staged) return await this.settleReceipt(ctx, draft, claim.claimToken, staged.receipt);
      }
      const handle = await this.deps.handles.resolveForSend(ctx.pluginInstanceId, draft.address);
      const provenance = stampProvenance(ctx, draft, handle);
      const audience = deriveAudience(draft, handle, this.isKnownCatId);
      const content = renderElementsText(draft.payload.elements);
      // F202 C1 gap A: authenticated external ingress carries the wake authority a
      // `thread_handle` deliberately does not (F288 v0). Whisper ingress is excluded — an
      // audience-restricted message must not be broadcast to the thread room. Host-owned
      // source metadata does not suppress this wake; only an explicit Host wake overrides it.
      const wake =
        hostOptions?.wake === undefined &&
        handle.kind === 'connector_binding' &&
        handle.connectorBinding &&
        this.deps.ingressWake
          ? 'auto'
          : hostOptions?.wake;
      if (wake !== undefined && !this.deps.ingressWake) {
        throw new MessagingError('VALIDATION', 'Host wake services are unavailable');
      }
      let wakeCatId: CatId | undefined;
      if (wake === 'auto' && this.deps.ingressWake) {
        wakeCatId = await deriveIngressTarget(this.deps.ingressWake, handle.threadId, content);
      } else if (typeof wake === 'object') {
        if (!this.isKnownCatId(wake.catId)) {
          throw new MessagingError('VALIDATION', `unknown cat ${wake.catId}`);
        }
        wakeCatId = wake.catId as CatId;
      }
      const source =
        hostOptions?.source ??
        (handle.kind === 'connector_binding' && handle.connectorBinding
          ? sourceForConnectorIngress(handle.connectorBinding.connectorId, handle.connectorBinding.externalChatId)
          : undefined);
      const ingress: ResolvedIngress | undefined =
        source && this.deps.ingressWake && audience.kind !== 'whisper'
          ? { deps: this.deps.ingressWake, source, ...(wakeCatId === undefined ? {} : { catId: wakeCatId }) }
          : undefined;

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

      // Check immediately before persistence, after potentially slow handle/parent resolution.
      if (
        draft.payload.elements.some(
          (element) => element.kind === 'media_ref' && element.payload.reference.startsWith('hmr_'),
        )
      ) {
        if (!this.deps.mediaReferences) throw new MessagingError('MEDIA_ACCESS_DENIED', 'Media access denied');
        await this.deps.mediaReferences.assertCanReference(ctx.pluginInstanceId, draft.payload.elements);
      }
      const timestamp = Date.now();
      const appendInput: AppendMessageInput = {
        threadId: handle.threadId,
        userId: handle.userId,
        catId: null,
        content,
        // v0: plugin sends never trigger @-routing (wake power is K-3a scope). Authenticated
        // connector ingress is the one exception, and its target is Host-derived — never read
        // from the package's own text claim.
        mentions: wakeCatId === undefined ? [] : [wakeCatId],
        timestamp,
        ...(source === undefined ? {} : { source }),
        ...(hostOptions?.contentBlocks === undefined ? {} : { contentBlocks: hostOptions.contentBlocks }),
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
      };

      const accepted = await this.acceptPendingMedia({ ctx, draft, handle, appendInput, hostOptions, timestamp });
      if (accepted) return await this.settleReceipt(ctx, draft, claim.claimToken, accepted);

      const stored = await this.deps.messageStore.append(appendInput);

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
        this.deps.onPublished?.(handle.threadId);
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

      // The ingress effects carry their own durable fences. The send claim cannot fence them:
      // releasing it is how a failed attempt hands the work back, but a broadcast already on the
      // wire and a cat already woken do not come back with it. Persist converges on one message id
      // and publish dedupes on its deterministic event key; broadcast and wake had neither, so a
      // settlement failure let the retry wake the same cat a second time (sixth-round review P1).
      //
      // Each effect settles on its OWN terms, and the wake settles only AFTER it is admitted
      // (seventh-round review P1). The earlier fence settled before the effects on the argument
      // that a duplicated wake costs a whole agent turn — which is false here: connector-sourced
      // invocations are admitted under the durable key `connector-${messageId}`
      // (QueueProcessor.ts:4247-4255), so a retry is deduped where it lands. Settling first bought
      // nothing and cost a permanent silence: one failed trigger fenced the wake out forever while
      // this send still returned a success receipt.
      if (ingress) {
        await deliverIngressEffectsOnce(this.deps.ledger, {
          instanceId: ctx.pluginInstanceId,
          idempotencyKey: draft.idempotencyKey,
          threadId: handle.threadId,
          userId: handle.userId,
          messageId: stored.id,
          content,
          ...(hostOptions?.contentBlocks === undefined ? {} : { contentBlocks: hostOptions.contentBlocks }),
          ...(hostOptions?.sender === undefined ? {} : { sender: hostOptions.sender }),
          timestamp,
          ingress,
        });
      }

      const receipt: SendReceipt = {
        messageId: stored.id,
        threadId: handle.threadId,
        revision: 1,
        messageHandle: { kind: 'message' as const, token: msgHandle.handleId },
        ...(publishSequence !== undefined ? { publishSequence } : {}),
      };
      return await this.settleReceipt(ctx, draft, claim.claimToken, receipt);
    } catch (err) {
      await this.deps.ledger.releaseSend(ctx.pluginInstanceId, draft.idempotencyKey, claim.claimToken);
      throw err;
    }
  }

  private async acceptPendingMedia(input: {
    ctx: PluginCallContext;
    draft: MessageDraft;
    handle: AddressHandleRecord;
    appendInput: AppendMessageInput;
    hostOptions?: HostSendOptions;
    timestamp: number;
  }): Promise<SendReceipt | null> {
    const { ctx, draft, handle, appendInput, hostOptions, timestamp } = input;
    const pendingMedia = draft.payload.elements.filter(
      (element): element is Extract<(typeof draft.payload.elements)[number], { kind: 'media_ref' }> =>
        element.kind === 'media_ref' && element.payload.reference.startsWith('pmr_'),
    );
    if (pendingMedia.length === 0) return null;
    const sourceEventId = draft.sourceEventId;
    if (!sourceEventId || !this.deps.mediaPending || !this.deps.mediaSources) {
      throw new MessagingError('VALIDATION', 'media-source is unavailable');
    }
    const key = mediaStageKey(ctx.pluginInstanceId, sourceEventId, draft.idempotencyKey);
    const existing = await this.deps.mediaPending.get(key);
    if (existing) return existing.receipt;
    const identity = hostOptions?.source.connector ?? handle.connectorBinding?.connectorId;
    if (!identity) throw new MessagingError('VALIDATION', 'media-source requires an ingress identity');
    for (const media of pendingMedia) {
      if (
        !media.payload.sourceId ||
        !(await this.deps.mediaSources.resolve(ctx.pluginInstanceId, media.payload.sourceId, identity))
      ) {
        throw new MessagingError('VALIDATION', 'media-source is not bound to this ingress identity');
      }
    }
    const messageId = generateSortableId(timestamp);
    const msgHandle = await this.deps.handles.ensureMessageHandle(handle, messageId);
    const receipt: SendReceipt = {
      messageId,
      threadId: handle.threadId,
      revision: 1,
      messageHandle: { kind: 'message', token: msgHandle.handleId },
      pendingPublication: true,
    };
    const media: StagedMediaSend['media'] = pendingMedia.map((element) => {
      const sourceId = element.payload.sourceId;
      if (!sourceId) throw new MessagingError('VALIDATION', 'media-source id is missing');
      return {
        input: {
          instanceId: ctx.pluginInstanceId,
          sourceEventId,
          elementId: element.elementId,
          reference: element.payload.reference,
          sourceId,
          requestId: randomUUID(),
          ingressIdentity: identity,
          type: element.payload.type,
          ...(element.payload.fileName === undefined ? {} : { fileName: element.payload.fileName }),
        },
      };
    });
    const row: StagedMediaSend = {
      key,
      instanceId: ctx.pluginInstanceId,
      sourceEventId,
      idempotencyKey: draft.idempotencyKey,
      receipt,
      draft,
      appendInput,
      ...(hostOptions?.sender === undefined ? {} : { sender: hostOptions.sender }),
      media,
      createdAt: this.deps.mediaPending.now(),
      deadline: this.deps.mediaPending.deadline(),
      published: false,
    };
    return this.deps.mediaPending.accept(row);
  }

  private async settleReceipt(
    ctx: PluginCallContext,
    draft: MessageDraft,
    claimToken: string,
    receipt: SendReceipt,
  ): Promise<SendReceipt> {
    const result = await this.deps.ledger.settleSend(ctx.pluginInstanceId, draft.idempotencyKey, claimToken, receipt);
    if (result.status === 'freshly_settled') return receipt;
    if (result.status === 'already_settled') return result.receipt as SendReceipt;
    // rejected — re-claim to get the canonical receipt.
    const canonical = await this.deps.ledger.claimSend(ctx.pluginInstanceId, draft.idempotencyKey);
    if (canonical.status === 'settled') return canonical.receipt;
    throw new MessagingError('RETRYABLE_INFLIGHT', 'send settlement was superseded — retry');
  }
}
