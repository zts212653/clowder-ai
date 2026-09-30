import type { MessageContent } from '@cat-cafe/shared';
import type { MessageElement, SendReceipt } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { projectEnvelope, readPluginMessageExtra, renderElementsText } from './envelope.js';
import { deliverIngressEffectsOnce, type MessagingIngressWakeDeps } from './ingress-wake.js';
import type { MessagingLedger } from './ledger.js';
import {
  MEDIA_IMPORT_DEADLINE_MS,
  type MediaImporter,
  type MediaImportResult,
  type MediaStagingStore,
  type StagedMediaSend,
} from './media-staging.js';
import { clampRetention, type EventLogStore } from './stores/ports.js';

function placeholderFileName(fileName: string | undefined): string {
  return (fileName ?? 'unnamed')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:hmr|pmr)_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 256);
}

export interface PendingPublicationDeps {
  readonly store: MediaStagingStore;
  readonly messageStore: IMessageStore;
  readonly events: EventLogStore;
  readonly importer?: MediaImporter;
  /** Only opaque IDs cross the logging boundary; callback errors can carry plugin secrets. */
  readonly onSettleFailure?: (fields: { messageId: string; elementId: string }) => void;
  readonly ledger: MessagingLedger;
  readonly onPublished?: (threadId: string) => void;
  readonly ingressWake?: MessagingIngressWakeDeps;
  readonly retentionCount?: number;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  /** e2 replaces this no-op with Host media post-processing. */
  readonly postProcess?: (
    imported: readonly { elementId: string; hmrId: string; type: string; fileName?: string }[],
    deadline: number,
  ) => Promise<{
    readonly warnings: readonly MessageElement[];
    readonly contentBlocks?: readonly MessageContent[];
    readonly transcript?: string;
  }>;
}

export class PendingMediaPublication {
  private readonly busy = new Set<string>();
  private readonly importing = new Set<string>();
  private readonly settling = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: PendingPublicationDeps) {}

  now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  deadline(): number {
    return this.now() + (this.deps.deadlineMs ?? MEDIA_IMPORT_DEADLINE_MS);
  }

  async get(key: string): Promise<StagedMediaSend | null> {
    return this.deps.store.get(key);
  }

  async isUnpublished(messageId: string): Promise<boolean> {
    return (await this.deps.store.list()).some((row) => row.receipt.messageId === messageId && !row.published);
  }

  async accept(row: StagedMediaSend): Promise<SendReceipt> {
    const winner = await this.deps.store.putIfAbsent(row);
    this.schedule(winner);
    return winner.receipt;
  }

  private schedule(row: StagedMediaSend): void {
    if (row.published) return;
    const old = this.timers.get(row.key);
    if (old) clearTimeout(old);
    const timer = setTimeout(
      () => {
        this.timers.delete(row.key);
        void this.expire(row.key).catch(() => {
          console.error('[messaging] pending publication deadline failed', { messageId: row.receipt.messageId });
        });
      },
      Math.max(0, row.deadline - this.now()),
    );
    timer.unref?.();
    this.timers.set(row.key, timer);
    if (this.deps.importer) {
      // The original send action must return its accepted receipt before Host callbacks begin.
      const start = setImmediate(() => {
        void this.importPending(row.key).catch(() => {
          console.error('[messaging] media import failed', { messageId: row.receipt.messageId });
        });
      });
      start.unref?.();
    }
  }

  async recover(): Promise<void> {
    for (const row of await this.deps.store.list()) {
      if (row.published) {
        await this.settlePublished(row.key);
        continue;
      }
      if (row.deadline <= this.now()) await this.expire(row.key);
      else {
        this.schedule(row);
        if (row.media.every((media) => media.result !== undefined)) await this.finalize(row.key);
      }
    }
  }

  private async importPending(key: string): Promise<void> {
    if (this.importing.has(key)) return;
    this.importing.add(key);
    try {
      await this.importUnsettled(key);
    } finally {
      this.importing.delete(key);
    }
  }

  private async importUnsettled(key: string): Promise<void> {
    const row = await this.deps.store.get(key);
    if (!row || row.published || !this.deps.importer) return;
    for (const media of row.media) {
      if (media.result) continue;
      let result: MediaImportResult;
      try {
        result = await this.deps.importer.import({ ...media.input, deadline: row.deadline });
        if (result.kind === 'imported' && !result.hmrId.startsWith('hmr_')) {
          result = { kind: 'unavailable', reason: 'unavailable' };
        }
      } catch {
        result = { kind: 'unavailable', reason: 'unavailable' };
      }
      await this.deps.store.update(key, (current) => {
        if (current.published || current.deadline <= this.now()) return current;
        return {
          ...current,
          media: current.media.map((item) =>
            item.input.elementId === media.input.elementId && !item.result ? { ...item, result } : item,
          ),
        };
      });
    }
    await this.finalize(key);
  }

  async expire(key: string, reason: 'timeout' | 'unavailable' = 'timeout'): Promise<void> {
    await this.deps.store.update(key, (row) => {
      if (row.published) return row;
      return {
        ...row,
        media: row.media.map((item) =>
          item.result ? item : { ...item, result: { kind: 'unavailable' as const, reason } },
        ),
      };
    });
    await this.finalize(key);
  }

  async uninstall(instanceId: string): Promise<void> {
    for (const row of await this.deps.store.list()) {
      if (row.instanceId === instanceId && !row.published) await this.expire(row.key, 'unavailable');
    }
  }

  private async settlePublished(key: string): Promise<void> {
    if (!this.deps.importer?.settle || this.settling.has(key)) return;
    this.settling.add(key);
    try {
      const row = await this.deps.store.get(key);
      if (!row?.published) return;
      for (const media of row.media) {
        if (!media.result || media.settled) continue;
        try {
          await this.deps.importer.settle(media.input, media.result.kind === 'imported' ? 'imported' : 'unavailable');
          await this.deps.store.update(key, (current) => ({
            ...current,
            media: current.media.map((item) =>
              item.input.elementId === media.input.elementId ? { ...item, settled: true } : item,
            ),
          }));
        } catch {
          await this.recordSettleFailure(key, row.receipt.messageId, media.input.elementId);
        }
      }
    } finally {
      this.settling.delete(key);
    }
  }

  private async recordSettleFailure(key: string, messageId: string, elementId: string): Promise<void> {
    try {
      await this.deps.store.update(key, (current) => ({
        ...current,
        media: current.media.map((item) =>
          item.input.elementId === elementId
            ? { ...item, settleFailures: (item.settleFailures ?? 0) + 1, lastSettleFailureAt: this.now() }
            : item,
        ),
      }));
    } catch {
      // Publication is already durable; an audit-write failure must not rewrite its outcome.
    }
    try {
      this.deps.onSettleFailure?.({ messageId, elementId });
    } catch {
      // Host logging is not part of the published-message transaction.
    }
  }

  private async finalElements(row: StagedMediaSend): Promise<{
    elements: readonly MessageElement[];
    contentBlocks?: readonly MessageContent[];
    transcript?: string;
    content: string;
  }> {
    const outcomes = new Map(row.media.map((item) => [item.input.elementId, item.result]));
    const elements = row.draft.payload.elements.map((element): MessageElement => {
      if (element.kind !== 'media_ref' || !element.payload.reference.startsWith('pmr_')) return element;
      const result = outcomes.get(element.elementId);
      if (!result) throw new Error('pending media element has no terminal outcome');
      const { type, fileName } = element.payload;
      if (result.kind === 'imported') {
        return {
          ...element,
          payload: { type, ...(fileName === undefined ? {} : { fileName }), reference: result.hmrId },
        };
      }
      return {
        ...element,
        kind: 'media_unavailable',
        payload: { type, ...(fileName === undefined ? {} : { fileName }), reason: result.reason },
      };
    });
    const imported = row.media.flatMap((item) =>
      item.result?.kind === 'imported'
        ? [
            {
              elementId: item.input.elementId,
              hmrId: item.result.hmrId,
              type: item.input.type,
              ...(item.input.fileName === undefined ? {} : { fileName: item.input.fileName }),
            },
          ]
        : [],
    );
    const processed = await this.deps.postProcess?.(imported, row.deadline);
    const finalElements = [
      ...elements.filter((element) => element.kind === 'text'),
      ...elements.filter((element) => element.kind !== 'text'),
      ...(processed?.warnings ?? []),
    ];
    const importedIds = new Set(imported.map((media) => media.elementId));
    return {
      elements: finalElements,
      ...(processed?.contentBlocks === undefined ? {} : { contentBlocks: processed.contentBlocks }),
      ...(processed?.transcript === undefined ? {} : { transcript: processed.transcript }),
      content: finalElements
        .map((element) => {
          if (
            importedIds.has(element.elementId) &&
            element.kind === 'media_ref' &&
            (element.payload.type === 'file' || element.payload.type === 'video')
          ) {
            return `[${element.payload.type}: ${placeholderFileName(element.payload.fileName)}]`;
          }
          return renderElementsText([element]);
        })
        .join('\n'),
    };
  }

  private async wakeIngress(row: StagedMediaSend, stored: StoredMessage): Promise<void> {
    if (!row.appendInput.source || !this.deps.ingressWake) return;
    await deliverIngressEffectsOnce(this.deps.ledger, {
      instanceId: row.instanceId,
      idempotencyKey: row.idempotencyKey,
      threadId: stored.threadId,
      userId: stored.userId,
      messageId: stored.id,
      content: stored.content,
      ...(stored.contentBlocks === undefined ? {} : { contentBlocks: stored.contentBlocks }),
      ...(row.sender === undefined ? {} : { sender: row.sender }),
      timestamp: stored.timestamp,
      ingress: {
        deps: this.deps.ingressWake,
        source: row.appendInput.source,
        ...(stored.mentions[0] === undefined ? {} : { catId: stored.mentions[0] }),
      },
    });
  }

  async finalize(key: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const row = await this.deps.store.get(key);
      if (!row || row.published || row.media.some((item) => !item.result)) return;
      const processed = await this.finalElements(row);
      const elements = processed.elements;
      const pluginExtra = row.appendInput.extra?.pluginMessage;
      if (!pluginExtra) throw new Error('staged message lost plugin payload');
      const stored = await this.deps.messageStore.append({
        ...row.appendInput,
        reservedId: row.receipt.messageId,
        content: [processed.content, processed.transcript].filter(Boolean).join('\n'),
        ...(processed.contentBlocks === undefined
          ? {}
          : { contentBlocks: [...(row.appendInput.contentBlocks ?? []), ...processed.contentBlocks] }),
        extra: { ...row.appendInput.extra, pluginMessage: { ...pluginExtra, elements } },
      });
      if (stored.id !== row.receipt.messageId) throw new Error('staged publication message id mismatch');
      const envelope = projectEnvelope(stored);
      if (!envelope) throw new Error('staged publication failed envelope projection');
      const emitted = await this.deps.events.append(
        stored.threadId,
        `publish:${stored.id}:1`,
        { eventId: `ev_pub_${stored.id}_1`, type: 'message.publish', envelope },
        clampRetention(this.deps.retentionCount),
      );
      if (emitted.fencedOut || emitted.sequence === undefined) throw new Error('staged publication has no sequence');
      const plugin = readPluginMessageExtra(stored);
      if (!plugin) throw new Error('staged publication lost canonical payload');
      const marked = await this.deps.messageStore.updatePluginMessage(
        stored.id,
        { ...plugin, outputRevision: plugin.revision, outputSequence: emitted.sequence },
        plugin.revision,
      );
      if (!marked) throw new Error('staged publication watermark was not persisted');
      // The event append and downstream drain are separate durable boundaries. A
      // crash between them replays a deduped event but must still wake the drain.
      this.deps.onPublished?.(stored.threadId);
      await this.wakeIngress(row, stored);
      await this.deps.store.update(key, (current) => ({ ...current, published: true }));
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      await this.settlePublished(key).catch(() => {
        // The publication boundary is complete; settle can be retried from the staged row on recovery.
      });
    } finally {
      this.busy.delete(key);
    }
  }
}
