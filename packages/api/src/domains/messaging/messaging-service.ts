/**
 * Plugin Messaging — domain facade (K-1 / F288)
 *
 * The single consumption surface for the K-2 Host Broker: handle issuance
 * (control plane takes over the entry point in K-2), messaging.send,
 * messaging.appendElements, and the cursor-based output event subscription.
 * Composes the domain services over one MessagingStores set.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AppendReceipt, M0CSnapshotInput, M0CSnapshotResult, SendReceipt } from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { AppendService } from './append-service.js';
import type { PluginCallContext, ReadResult, SnapshotResult, SubscribeResult } from './contract/host-types.js';
import { EventStreamService } from './event-stream.js';
import { HandleService, type IssueConnectorBindingHandleInput, type IssueThreadHandleInput } from './handles.js';
import type { MessagingIngressWakeDeps } from './ingress-wake.js';
import { MessagingLedger } from './ledger.js';
import type { MediaEntitlementLedger } from './media-entitlements.js';
import type { PendingMediaPublication } from './media-pending-publication.js';
import type { MediaReferenceAuthority } from './media-reference-authority.js';
import type { MediaSourceResolver } from './media-staging.js';
import type { OutboundMediaStore } from './outbound-media/store.js';
import { type HostSendOptions, SendService } from './send-service.js';
import { createMessagingStores } from './stores/factory.js';
import type { MessagingStores } from './stores/ports.js';

export interface MessagingDomainDeps extends Partial<MessagingIngressWakeDeps> {
  readonly messageStore: IMessageStore;
  readonly redis?: RedisClient;
  /**
   * Stores already built by composition. Supply these when something outside the domain must
   * write to the same event log the domain reads — the publishing store that puts every
   * author's message on the stream is exactly that case, and against Redis it would happen to
   * agree by key while silently disagreeing anywhere else.
   */
  readonly stores?: MessagingStores;
  readonly onPublished?: (threadId: string) => void;
  readonly isKnownCatId?: (catId: string) => boolean;
  /** Event log retention per thread (events beyond this are trimmed; stale+snapshot covers the gap). */
  readonly retentionCount?: number;
  readonly mediaReferences?: MediaReferenceAuthority;
  readonly mediaEntitlements?: Pick<MediaEntitlementLedger, 'grantMany' | 'revoke'>;
  readonly mediaPending?: PendingMediaPublication;
  readonly mediaSources?: MediaSourceResolver;
  readonly snapshotClock?: { now(): number };
  readonly snapshotAckTokenTtlMs?: number;
  /** Deferred Host media messages (W2-5b); the snapshot projects them only once published. */
  readonly outboundMedia?: Pick<OutboundMediaStore, 'get'>;
}

/**
 * F202 C1 gaps A/B: the wake collaborators are offered flat at this K-2 assembly point, and are
 * only honoured as a complete set. A partial set would silently derive a target it cannot deliver.
 */
export function ingressWakeDeps(deps: MessagingDomainDeps): MessagingIngressWakeDeps | undefined {
  if (!deps.invokeTrigger || !deps.getDefaultCatId || !deps.getMentionPatterns) return undefined;
  return {
    invokeTrigger: deps.invokeTrigger,
    getDefaultCatId: deps.getDefaultCatId,
    getMentionPatterns: deps.getMentionPatterns,
    ...(deps.socketManager === undefined ? {} : { socketManager: deps.socketManager }),
    ...(deps.threadStore === undefined ? {} : { threadStore: deps.threadStore }),
  };
}

export class MessagingService {
  private readonly stores: MessagingStores;
  private readonly mediaEntitlements?: Pick<MediaEntitlementLedger, 'grantMany' | 'revoke'>;
  private readonly handles: HandleService;
  private readonly sendService: SendService;
  private readonly appendService: AppendService;
  private readonly stream: EventStreamService;

  constructor(deps: MessagingDomainDeps) {
    const stores = deps.stores ?? createMessagingStores(deps.redis);
    this.stores = stores;
    this.mediaEntitlements = deps.mediaEntitlements;
    const ledger = new MessagingLedger(stores.ledger);
    this.handles = new HandleService(stores.handles, stores.cursors, deps.mediaPending);
    const ingressWake = ingressWakeDeps(deps);
    this.sendService = new SendService({
      messageStore: deps.messageStore,
      handles: this.handles,
      ledger,
      events: stores.events,
      ...(deps.mediaReferences === undefined ? {} : { mediaReferences: deps.mediaReferences }),
      ...(deps.mediaPending === undefined ? {} : { mediaPending: deps.mediaPending }),
      ...(deps.mediaSources === undefined ? {} : { mediaSources: deps.mediaSources }),
      ...(deps.retentionCount !== undefined ? { retentionCount: deps.retentionCount } : {}),
      ...(ingressWake === undefined ? {} : { ingressWake }),
      ...(deps.onPublished === undefined ? {} : { onPublished: deps.onPublished }),
      ...(deps.isKnownCatId === undefined ? {} : { isKnownCatId: deps.isKnownCatId }),
    });
    this.appendService = new AppendService({
      messageStore: deps.messageStore,
      ledger,
      handles: this.handles,
      events: stores.events,
      appendLock: stores.appendLock,
      ...(deps.mediaReferences === undefined ? {} : { mediaReferences: deps.mediaReferences }),
      ...(deps.retentionCount !== undefined ? { retentionCount: deps.retentionCount } : {}),
    });
    this.stream = new EventStreamService({
      events: stores.events,
      cursors: stores.cursors,
      handles: this.handles,
      messageStore: deps.messageStore,
      publications: stores.publications,
      ...(deps.outboundMedia === undefined ? {} : { outboundMedia: deps.outboundMedia }),
      ...(deps.mediaEntitlements === undefined ? {} : { mediaEntitlements: deps.mediaEntitlements }),
      ...(deps.snapshotClock === undefined ? {} : { snapshotClock: deps.snapshotClock }),
      ...(deps.snapshotAckTokenTtlMs === undefined ? {} : { snapshotAckTokenTtlMs: deps.snapshotAckTokenTtlMs }),
    });
  }

  // ── Handle issuance (K-2 control plane calls these) ──

  issueThreadHandle(input: IssueThreadHandleInput): Promise<{ handleId: string }> {
    return this.handles.issueThreadHandle(input);
  }

  issueConnectorBindingHandle(input: IssueConnectorBindingHandleInput): Promise<{ handleId: string }> {
    return this.handles.issueConnectorBindingHandle(input);
  }

  ensureThreadHandle(input: IssueThreadHandleInput): Promise<{ handleId: string }> {
    return this.handles.ensureThreadHandle(input);
  }

  ensureConnectorBindingHandle(input: IssueConnectorBindingHandleInput): Promise<{ handleId: string }> {
    return this.handles.ensureConnectorBindingHandle(input);
  }

  async revokeHandle(handleId: string): Promise<void> {
    const handle = await this.stores.handles.get(handleId);
    const sub = handle ? await this.stores.cursors.findByHandle(handle.pluginInstanceId, handleId) : null;
    const lease = sub?.snapshotView?.activePageLease;
    if (lease) {
      await this.mediaEntitlements?.revoke(
        { scope: { kind: 'snapshot', sessionId: lease.sessionId } },
        'snapshot_revoked',
      );
    }
    await this.handles.revoke(handleId);
  }

  // ── messaging.* call surface ──

  send(ctx: PluginCallContext, draft: unknown): Promise<SendReceipt> {
    return this.sendService.send(ctx, draft);
  }

  sendFromHost(ctx: PluginCallContext, draft: unknown, options: HostSendOptions): Promise<SendReceipt> {
    return this.sendService.send(ctx, draft, options);
  }

  appendElements(ctx: PluginCallContext, input: unknown): Promise<AppendReceipt> {
    return this.appendService.appendElements(ctx, input);
  }

  // ── Output event subscription surface ──

  subscribe(ctx: PluginCallContext, handleId: string): Promise<SubscribeResult> {
    return this.stream.subscribe(ctx, handleId);
  }

  withdrawSubscription(ctx: PluginCallContext, handleId: string): Promise<void> {
    return this.stream.withdraw(ctx, handleId);
  }

  read(ctx: PluginCallContext, subscriptionId: string, options: { limit?: number }): Promise<ReadResult> {
    return this.stream.read(ctx, subscriptionId, options);
  }

  ack(ctx: PluginCallContext, subscriptionId: string, token: string): Promise<void> {
    return this.stream.ack(ctx, subscriptionId, token);
  }

  snapshot(ctx: PluginCallContext, subscriptionId: string): Promise<SnapshotResult> {
    return this.stream.snapshot(ctx, subscriptionId);
  }

  snapshotPage(ctx: PluginCallContext, input: M0CSnapshotInput): Promise<M0CSnapshotResult> {
    return this.stream.snapshotPage(ctx, input);
  }
}

export function createMessagingDomain(deps: MessagingDomainDeps): MessagingService {
  return new MessagingService(deps);
}
