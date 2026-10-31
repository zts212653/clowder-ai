/**
 * Durable append-output state machine (F288 D-3, INV-14..18).
 *
 * The message store owns revision/outbox state; the event store owns sequence
 * assignment. Every append event carries the live AppendLease so Redis can
 * validate ownership in the same Lua operation as insertion. Watermarks move
 * one revision at a time and therefore describe contiguous public output.
 */

import type { MessageElement } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { MessagingError } from './contract/host-types.js';
import { type AppendOpRecord, type PluginMessageExtra, readPluginMessageExtra } from './envelope.js';
import type { AppendLease, EventLogStore } from './stores/ports.js';
import { clampRetention } from './stores/ports.js';

export interface AppendOutputDeps {
  readonly messageStore: IMessageStore;
  readonly events: EventLogStore;
  readonly retentionCount?: number;
}

export interface AppendOutputState {
  readonly message: StoredMessage;
  readonly plugin: PluginMessageExtra;
  readonly sequenceByOperation: ReadonlyMap<string, number>;
}

export interface AppendRevisionOutput {
  readonly message: StoredMessage;
  readonly plugin: PluginMessageExtra;
  readonly sequence?: number;
}

type AppendEmissionResult =
  | { readonly status: 'emitted'; readonly sequence: number }
  | { readonly status: 'not_applicable' }
  | { readonly status: 'fenced_out' };

interface RecordEmissionResult extends AppendRevisionOutput {
  readonly halted: boolean;
}

export class AppendOutputCoordinator {
  private readonly deps: AppendOutputDeps;
  private readonly retentionCount: number;

  constructor(deps: AppendOutputDeps) {
    this.deps = deps;
    this.retentionCount = clampRetention(deps.retentionCount);
  }

  async reconcile(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    replayOperationId: string | undefined,
    lease: AppendLease,
  ): Promise<AppendOutputState> {
    const sequenceByOperation = new Map<string, number>();
    let state = await this.repairMissingOutput(message, plugin, lease, sequenceByOperation);
    if (replayOperationId !== undefined && !sequenceByOperation.has(replayOperationId)) {
      state = await this.replayLatestOutput(state.message, state.plugin, replayOperationId, lease, sequenceByOperation);
    }
    return { ...state, sequenceByOperation };
  }

  async emitRevision(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    revision: number,
    lease: AppendLease,
  ): Promise<AppendRevisionOutput> {
    const record = plugin.appendOps[revision - 2] as AppendOpRecord | undefined;
    if (!record) throw new MessagingError('VALIDATION', `persisted append history is missing revision ${revision}`);
    const emitted = await this.emitRecord(message, plugin, record, revision, lease);
    return {
      message: emitted.message,
      plugin: emitted.plugin,
      ...(emitted.sequence !== undefined ? { sequence: emitted.sequence } : {}),
    };
  }

  private async repairMissingOutput(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    lease: AppendLease,
    sequences: Map<string, number>,
  ): Promise<AppendRevisionOutput> {
    if (message.visibility === 'whisper') return { message, plugin };
    let current: AppendRevisionOutput = { message, plugin };
    const firstMissingRevision = Math.max(2, (plugin.outputRevision ?? 1) + 1);
    for (let revision = firstMissingRevision; revision <= current.plugin.revision; revision += 1) {
      const record = current.plugin.appendOps[revision - 2] as AppendOpRecord | undefined;
      if (!record) throw new MessagingError('VALIDATION', `persisted append history is missing revision ${revision}`);
      const emitted = await this.emitRecord(current.message, current.plugin, record, revision, lease);
      current = emitted;
      if (emitted.sequence !== undefined) sequences.set(record.operationId, emitted.sequence);
      if (emitted.halted) break;
    }
    return current;
  }

  private async replayLatestOutput(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    operationId: string,
    lease: AppendLease,
    sequences: Map<string, number>,
  ): Promise<AppendRevisionOutput> {
    const index = plugin.appendOps.findIndex((record) => record.operationId === operationId);
    const revision = index + 2;
    if (index < 0 || revision !== plugin.revision || plugin.outputRevision !== revision) return { message, plugin };
    const record = plugin.appendOps[index] as AppendOpRecord;
    const emitted = await this.emitRecord(message, plugin, record, revision, lease);
    if (emitted.sequence !== undefined) sequences.set(operationId, emitted.sequence);
    return emitted;
  }

  private async emitRecord(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    record: AppendOpRecord,
    revision: number,
    lease: AppendLease,
  ): Promise<RecordEmissionResult> {
    const elements = plugin.elements.filter((element) => record.elementIds.includes(element.elementId));
    const emission = await this.emitAppendEvent(
      message,
      record.operationId,
      revision,
      elements,
      record.baseRevision,
      lease,
    );
    if (emission.status === 'fenced_out') {
      const covered = await this.resolveFencedOutput(message.id, revision);
      return { ...covered, halted: true };
    }
    if (emission.status === 'not_applicable') return { message, plugin, halted: true };
    const marked = await this.persistOutputWatermark(message, plugin, revision, emission.sequence);
    return { ...marked, sequence: emission.sequence, halted: false };
  }

  private async persistOutputWatermark(
    message: StoredMessage,
    plugin: PluginMessageExtra,
    outputRevision: number,
    sequence: number,
  ): Promise<AppendRevisionOutput> {
    const currentOutputRevision = plugin.outputRevision ?? 0;
    if (outputRevision < currentOutputRevision || outputRevision > currentOutputRevision + 1) {
      throw new MessagingError('VALIDATION', 'output watermark must advance contiguously without regression');
    }
    if (outputRevision > plugin.revision) {
      throw new MessagingError('VALIDATION', 'output watermark cannot exceed the persisted message revision');
    }
    const marked: PluginMessageExtra = { ...plugin, outputRevision, outputSequence: sequence };
    const written = await this.deps.messageStore.updatePluginMessage(
      message.id,
      marked as unknown as NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>,
      plugin.revision,
    );
    if (written) return this.requirePersistedPlugin(written);
    return this.resolveConcurrentWatermark(message.id, outputRevision);
  }

  private requirePersistedPlugin(message: StoredMessage): AppendRevisionOutput {
    const plugin = readPluginMessageExtra(message);
    if (!plugin) throw new MessagingError('VALIDATION', 'output watermark persistence produced invalid plugin state');
    return { message, plugin };
  }

  private async resolveConcurrentWatermark(messageId: string, outputRevision: number): Promise<AppendRevisionOutput> {
    const current = await this.deps.messageStore.getById(messageId);
    if (!current)
      throw new MessagingError('NOT_FOUND', `message ${messageId} disappeared before output watermark persisted`);
    const plugin = readPluginMessageExtra(current);
    if (plugin?.outputRevision !== undefined && plugin.outputRevision >= outputRevision)
      return { message: current, plugin };
    throw new MessagingError('CONFLICT', 'message revision changed before output watermark persisted');
  }

  private async resolveFencedOutput(messageId: string, targetRevision: number): Promise<AppendRevisionOutput> {
    const current = await this.deps.messageStore.getById(messageId);
    const plugin = current ? readPluginMessageExtra(current) : null;
    if (!current || !plugin || plugin.outputRevision === undefined || plugin.outputRevision < targetRevision) {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'append lease expired before output was durably represented');
    }
    return {
      message: current,
      plugin,
      ...(plugin.outputRevision === targetRevision && plugin.outputSequence !== undefined
        ? { sequence: plugin.outputSequence }
        : {}),
    };
  }

  private async emitAppendEvent(
    message: StoredMessage,
    operationId: string,
    revision: number,
    elements: readonly MessageElement[],
    baseRevision: number | undefined,
    lease: AppendLease,
  ): Promise<AppendEmissionResult> {
    if (message.visibility === 'whisper') return { status: 'not_applicable' };
    const emitted = await this.deps.events.append(
      message.threadId,
      `append:${message.id}:${operationId}`,
      {
        eventId: `ev_app_${message.id}_${operationId}`,
        type: 'message.elements.append',
        messageId: message.id,
        threadId: message.threadId,
        operationId,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        revision,
        elements,
      },
      this.retentionCount,
      lease,
    );
    if (emitted.fencedOut) return { status: 'fenced_out' };
    if (emitted.sequence === undefined) {
      throw new MessagingError('VALIDATION', 'event store accepted append output without assigning a sequence');
    }
    return { status: 'emitted', sequence: emitted.sequence };
  }
}
