/** Bounded, restart-safe frozen snapshot capture under the plugin event fence. */

import { randomUUID } from 'node:crypto';
import type { MessageElement } from '@clowder-ai/plugin-contract';
import { validateMessagingRowResult } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isInternalNonQuotableParent } from '../cats/services/stores/visibility.js';
import type { PluginCallContext, SnapshotResult } from './contract/host-types.js';
import { MessagingError, SnapshotUnavailableHostError } from './contract/host-types.js';
import { projectEnvelope, readPluginMessageExtra } from './envelope.js';
import type { OutboundMediaStore } from './outbound-media/store.js';
import type {
  CursorStore,
  EventLogStore,
  HostPublicationTracker,
  SnapshotViewRecord,
  SubscriptionRecord,
} from './stores/ports.js';

export const SNAPSHOT_MAX_ATTEMPTS = 3;
export const SNAPSHOT_SOURCE_PAGE_SIZE = 16;
export const SNAPSHOT_CAPTURE_MAX_SOURCE_ROWS = 4_096;
export const SNAPSHOT_CAPTURE_MAX_ITEMS = 4_096;
export const SNAPSHOT_CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
export const SNAPSHOT_PERSIST_CHUNK_MAX_ITEMS = 16;
export const SNAPSHOT_PERSIST_CHUNK_MAX_BYTES = 1024 * 1024;
export const SNAPSHOT_CAPTURE_LEASE_MS = 60_000;

interface SnapshotCaptureDeps {
  readonly events: EventLogStore;
  readonly cursors: CursorStore;
  readonly messageStore: IMessageStore;
  /** Host store-write → publish spans; a thread inside one cannot be snapshotted consistently. */
  readonly publications?: Pick<HostPublicationTracker, 'isBusy'>;
  /** Deferred Host media messages (W2-5b): their state and final media elements. */
  readonly outboundMedia?: Pick<OutboundMediaStore, 'get'>;
}

type SnapshotEnvelope = SnapshotResult['envelopes'][number];

function isSnapshotVisible(msg: StoredMessage): boolean {
  if (msg.visibility === 'whisper') return false;
  if (isInternalNonQuotableParent(msg as Parameters<typeof isInternalNonQuotableParent>[0])) return false;
  if (msg.extra?.systemKind !== undefined) return false;
  if (msg.extra?.scheduler?.hiddenTrigger) return false;
  if (msg.userId === 'scheduler') return false;
  return true;
}

/**
 * Every visible, live message is a candidate — package messages and Host (cat / user) messages
 * alike (W2-5b-0). Admitting only package messages meant a subscriber catching up by snapshot never
 * saw a cat's reply, and once media publication is deferred, never the final media message either.
 */
function isSnapshotCandidate(msg: StoredMessage): boolean {
  if (msg.deletedAt !== undefined || msg._tombstone) return false;
  return isSnapshotVisible(msg);
}

function isContractSnapshotEnvelope(envelope: SnapshotEnvelope): boolean {
  return validateMessagingRowResult('messaging.snapshot', {
    items: [envelope],
    nextPageToken: null,
    snapshotAckToken: 'capture-validation',
  }).valid;
}

/**
 * A Host message projects the same envelope its publish event carried. One the contract rejects is
 * a Host projection bug; it is left out and reported rather than failing every subscriber's
 * catch-up, which is what throwing here would do.
 */
function projectHostSnapshotEnvelope(
  msg: StoredMessage,
  hostMedia: readonly MessageElement[] | undefined,
): SnapshotEnvelope | null {
  const envelope = projectEnvelope(msg, hostMedia === undefined ? {} : { hostMedia });
  if (!envelope) return null;
  if (isContractSnapshotEnvelope(envelope)) return envelope;
  console.warn('[F202 W2-5b-0] host message left out of snapshot: envelope violates contract', {
    messageId: msg.id,
    threadId: msg.threadId,
  });
  return null;
}

export class SnapshotCaptureCoordinator {
  constructor(private readonly deps: SnapshotCaptureDeps) {}

  /**
   * A deferred Host media message (W2-5b) is in the snapshot only once published, with the media
   * elements its event carried. Pending: its event is still to come, so it is left for the stream.
   * Publishing: its event may already be past the head — a race, retried like one.
   */
  private async deferredHostMedia(
    msg: StoredMessage,
  ): Promise<readonly MessageElement[] | undefined | 'pending' | 'race'> {
    if (msg.extra?.mediaPublication !== 'deferred') return undefined;
    const row = await this.deps.outboundMedia?.get(msg.id);
    if (!row || row.state === 'pending') return 'pending';
    if (row.state === 'publishing') return 'race';
    return row.elements ?? [];
  }

  /** A Host message may be stored with its event still to come; that is a race, as for events. */
  private insidePublicationSpan(threadId: string): boolean {
    return this.deps.publications?.isBusy(threadId) ?? false;
  }

  async captureView(ctx: PluginCallContext, sub: SubscriptionRecord): Promise<SnapshotViewRecord> {
    for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      const headBefore = await this.deps.events.headSequence(sub.threadId);
      const createdAt = Date.now();
      const snapshotId = `snap_${randomUUID()}`;
      let started = false;
      try {
        const claim = await this.deps.cursors.beginSnapshotCapture(ctx.pluginInstanceId, sub.subscriptionId, {
          snapshotId,
          headSequence: headBefore,
          createdAt,
          expiresAt: createdAt + SNAPSHOT_CAPTURE_LEASE_MS,
        });
        if (!claim) throw new MessagingError('PERMISSION', 'subscription revoked during snapshot capture');
        if (claim.status === 'existing') return claim.snapshot;
        if (claim.status === 'busy') throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
        started = true;

        const captured = await this.scanAtHead(sub, headBefore, async (offset, items) => {
          const appended = await this.deps.cursors.appendSnapshotCapture(
            ctx.pluginInstanceId,
            sub.subscriptionId,
            snapshotId,
            offset,
            items,
          );
          if (!appended) throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
        });
        const headAfter = await this.deps.events.headSequence(sub.threadId);
        if (!captured || headBefore !== headAfter || this.insidePublicationSpan(sub.threadId)) {
          await this.deps.cursors.abortSnapshotCapture(ctx.pluginInstanceId, sub.subscriptionId, snapshotId);
          continue;
        }
        const snapshot = await this.deps.cursors.commitSnapshotCapture(ctx.pluginInstanceId, sub.subscriptionId, {
          snapshotId,
          expectedItemCount: captured.itemCount,
          nextOffset: 0,
          traversalComplete: false,
        });
        if (!snapshot) throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
        return snapshot;
      } catch (error) {
        if (started) {
          await this.deps.cursors
            .abortSnapshotCapture(ctx.pluginInstanceId, sub.subscriptionId, snapshotId)
            .catch(() => undefined);
        }
        if (error instanceof MessagingError || error instanceof SnapshotUnavailableHostError) throw error;
        throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      }
    }
    throw new MessagingError('RETRYABLE_INFLIGHT', 'snapshot raced an output mutation — retry later');
  }

  async captureInMemory(
    sub: SubscriptionRecord,
  ): Promise<{ items: SnapshotResult['envelopes']; headSequence: number }> {
    for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      const headBefore = await this.deps.events.headSequence(sub.threadId);
      const captured = await this.scanAtHead(sub, headBefore);
      const headAfter = await this.deps.events.headSequence(sub.threadId);
      if (!captured || headBefore !== headAfter || this.insidePublicationSpan(sub.threadId)) continue;
      return { items: captured.items, headSequence: headBefore };
    }
    throw new MessagingError('RETRYABLE_INFLIGHT', 'snapshot raced an output mutation — retry later');
  }

  private async scanAtHead(
    sub: SubscriptionRecord,
    headSequence: number,
    persistChunk?: (offset: number, items: readonly SnapshotEnvelope[]) => Promise<void>,
  ): Promise<{ items: SnapshotResult['envelopes']; itemCount: number } | null> {
    const captured: SnapshotEnvelope[] = [];
    let chunk: SnapshotEnvelope[] = [];
    let chunkBytes = 0;
    let sourceCursor: string | undefined;
    let sourceRows = 0;
    let itemCount = 0;
    let totalBytes = 0;

    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      if (persistChunk) await persistChunk(itemCount - chunk.length, chunk);
      else captured.push(...chunk);
      chunk = [];
      chunkBytes = 0;
    };

    while (true) {
      const messages = await this.deps.messageStore.getByThreadAfter(
        sub.threadId,
        sourceCursor,
        SNAPSHOT_SOURCE_PAGE_SIZE,
      );
      if (messages.length > SNAPSHOT_SOURCE_PAGE_SIZE) throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      if (messages.length === 0) break;
      sourceRows += messages.length;
      if (sourceRows > SNAPSHOT_CAPTURE_MAX_SOURCE_ROWS) {
        throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      }

      for (const msg of messages) {
        if (!isSnapshotCandidate(msg)) continue;
        let envelope: SnapshotEnvelope | null;
        if (msg.extra?.pluginMessage !== undefined) {
          const plugin = readPluginMessageExtra(msg);
          if (!plugin) throw new MessagingError('VALIDATION', 'persisted plugin message violates beta.11');
          if (
            plugin.outputRevision !== plugin.revision ||
            plugin.outputSequence === undefined ||
            plugin.outputSequence > headSequence
          ) {
            return null;
          }
          envelope = projectEnvelope(msg);
          if (!envelope || !isContractSnapshotEnvelope(envelope)) {
            throw new MessagingError('VALIDATION', 'persisted plugin envelope violates beta.11');
          }
        } else {
          const hostMedia = await this.deferredHostMedia(msg);
          if (hostMedia === 'race') return null;
          if (hostMedia === 'pending') continue;
          envelope = projectHostSnapshotEnvelope(msg, hostMedia);
          if (!envelope) continue;
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
        if (itemBytes > SNAPSHOT_PERSIST_CHUNK_MAX_BYTES) {
          throw new SnapshotUnavailableHostError('OVERSIZED_ITEM');
        }
        if (itemCount + 1 > SNAPSHOT_CAPTURE_MAX_ITEMS || totalBytes + itemBytes > SNAPSHOT_CAPTURE_MAX_BYTES) {
          throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
        }
        if (
          chunk.length >= SNAPSHOT_PERSIST_CHUNK_MAX_ITEMS ||
          (chunk.length > 0 && chunkBytes + itemBytes > SNAPSHOT_PERSIST_CHUNK_MAX_BYTES)
        ) {
          await flush();
        }
        chunk.push(envelope);
        chunkBytes += itemBytes;
        itemCount += 1;
        totalBytes += itemBytes;
      }

      const last = messages[messages.length - 1];
      if (!last || last.id === sourceCursor) throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      sourceCursor = last.id;
      if (messages.length < SNAPSHOT_SOURCE_PAGE_SIZE) break;
    }
    await flush();
    return { items: captured, itemCount };
  }
}
