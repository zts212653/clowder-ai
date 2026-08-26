/** Bounded, restart-safe frozen snapshot capture under the plugin event fence. */

import { randomUUID } from 'node:crypto';
import { validateMessagingRowResult } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isInternalNonQuotableParent } from '../cats/services/stores/visibility.js';
import type { PluginCallContext, SnapshotResult } from './contract/host-types.js';
import { MessagingError, SnapshotUnavailableHostError } from './contract/host-types.js';
import { projectEnvelope, readPluginMessageExtra } from './envelope.js';
import type { CursorStore, EventLogStore, SnapshotViewRecord, SubscriptionRecord } from './stores/ports.js';

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

function isSnapshotCandidate(msg: StoredMessage): boolean {
  if (msg.extra?.pluginMessage === undefined) return false;
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

export class SnapshotCaptureCoordinator {
  constructor(private readonly deps: SnapshotCaptureDeps) {}

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
        if (!captured || headBefore !== headAfter) {
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
      if (!captured || headBefore !== headAfter) continue;
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
        const plugin = readPluginMessageExtra(msg);
        if (!plugin) throw new MessagingError('VALIDATION', 'persisted plugin message violates beta.11');
        if (
          plugin.outputRevision !== plugin.revision ||
          plugin.outputSequence === undefined ||
          plugin.outputSequence > headSequence
        ) {
          return null;
        }
        const envelope = projectEnvelope(msg);
        if (!envelope || !isContractSnapshotEnvelope(envelope)) {
          throw new MessagingError('VALIDATION', 'persisted plugin envelope violates beta.11');
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
