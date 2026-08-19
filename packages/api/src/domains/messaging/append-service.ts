/**
 * Plugin Messaging — messaging.appendElements (K-1 / F288, AC-4, §4d)
 *
 * Atomicity: per-message owner-token lock serializes appends; the
 * read-check-write on extra.pluginMessage happens entirely inside the lock.
 * baseRevision gives callers optimistic concurrency on top (INV-10).
 *
 * Idempotency (INV-12): ledger key (instance, messageId, operationId) +
 * appendOps records INSIDE the lock cover the crash window between write and
 * settle. Each record stores the operation's elementIds, so replays rebuild
 * the receipt and the re-emitted event from the PERSISTED elements — a retry
 * that reuses an operationId with different elements is rejected, never
 * echoed back as applied.
 *
 * Provenance (INV-7): appended elements are stamped 'inference' unless they
 * explicitly claim a status equal to their derivation source's status —
 * appends can never elevate epistemic standing, and omission never inherits
 * the message-level status silently.
 *
 * Applied-revision derivation: send fixes revision 1 and each append bumps by
 * exactly 1, so the op at appendOps index i produced revision i+2 — derivable,
 * no extra state (派生值规则).
 *
 * Cumulative bounds (D-6): per-operation bounds alone would let a plugin grow
 * one message without limit through fresh operationIds; maxElementsPerMessage
 * and maxAppendOpsPerMessage cap the whole document (fail-closed).
 */

import type { AppendElementsRequest, AppendReceipt, MessageElement } from '@clowder-ai/plugin-contract';
import { MESSAGING_BOUNDS } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { payloadBytes, sameIdSet, stampAppendedElements } from './append-elements.js';
import { AppendOutputCoordinator } from './append-output.js';
import type { PluginCallContext } from './contract/host-types.js';
import { MessagingError } from './contract/host-types.js';
import { validateAppendInput } from './contract/validate.js';
import { type AppendOpRecord, type PluginMessageExtra, readPluginMessageExtra } from './envelope.js';
import type { HandleService } from './handles.js';
import type { MessagingLedger } from './ledger.js';
import type { AppendLease, AppendLock, EventLogStore } from './stores/ports.js';

export const APPEND_LOCK_TTL_MS = 5_000;

export interface AppendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly ledger: MessagingLedger;
  readonly handles: HandleService;
  readonly events: EventLogStore;
  readonly appendLock: AppendLock;
  readonly retentionCount?: number;
}

export class AppendService {
  private readonly deps: AppendServiceDeps;
  private readonly output: AppendOutputCoordinator;

  constructor(deps: AppendServiceDeps) {
    this.deps = deps;
    this.output = new AppendOutputCoordinator({
      messageStore: deps.messageStore,
      events: deps.events,
      ...(deps.retentionCount !== undefined ? { retentionCount: deps.retentionCount } : {}),
    });
  }

  async appendElements(ctx: PluginCallContext, input: unknown): Promise<AppendReceipt> {
    const parsed = validateAppendInput(input);
    const target = await this.deps.handles.resolveForAppend(ctx.pluginInstanceId, parsed.handle);
    const messageId = target.messageId;
    const claim = await this.deps.ledger.claimAppend(ctx.pluginInstanceId, messageId, parsed.operationId);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'an append with this operationId is in flight — retry later');
    }

    try {
      const lease = await this.deps.appendLock.acquire(messageId, APPEND_LOCK_TTL_MS);
      if (lease === null) {
        throw new MessagingError('RETRYABLE_INFLIGHT', 'message is being appended by another operation — retry later');
      }
      try {
        const receipt = await this.applyLocked(ctx, parsed, messageId, lease);
        const result = await this.deps.ledger.settleAppend(
          ctx.pluginInstanceId,
          messageId,
          parsed.operationId,
          claim.claimToken,
          receipt,
        );
        if (result.status === 'freshly_settled') return receipt;
        if (result.status === 'already_settled') return result.receipt as AppendReceipt;
        // rejected — re-claim to get the canonical receipt.
        const canonical = await this.deps.ledger.claimAppend(ctx.pluginInstanceId, messageId, parsed.operationId);
        if (canonical.status === 'settled') return canonical.receipt;
        throw new MessagingError('RETRYABLE_INFLIGHT', 'append settlement was superseded — retry');
      } finally {
        await this.deps.appendLock.release(messageId, lease);
      }
    } catch (err) {
      await this.deps.ledger.releaseAppend(ctx.pluginInstanceId, messageId, parsed.operationId, claim.claimToken);
      throw err;
    }
  }

  /** Runs inside the per-message lock. */
  private async applyLocked(
    ctx: PluginCallContext,
    parsed: AppendElementsRequest,
    messageId: string,
    lease: AppendLease,
  ): Promise<AppendReceipt> {
    const { msg, plugin } = await this.requirePluginMessage(ctx, messageId);

    const replay = await this.replayAppliedOperation(msg, plugin, parsed, lease);
    if (replay) return replay;

    if (parsed.baseRevision !== undefined && parsed.baseRevision !== plugin.revision) {
      throw new MessagingError('CONFLICT', 'baseRevision does not match the current revision (INV-10)', {
        baseRevision: parsed.baseRevision,
        currentRevision: plugin.revision,
      });
    }

    // D-6 cumulative caps: a message can never grow without bound across appends.
    if (plugin.appendOps.length + 1 > MESSAGING_BOUNDS.maxAppendOpsPerMessage) {
      throw new MessagingError(
        'VALIDATION',
        `message exceeds ${MESSAGING_BOUNDS.maxAppendOpsPerMessage} append operations`,
      );
    }
    if (plugin.elements.length + parsed.elements.length > MESSAGING_BOUNDS.maxElementsPerMessage) {
      throw new MessagingError(
        'VALIDATION',
        `message would exceed ${MESSAGING_BOUNDS.maxElementsPerMessage} total elements`,
      );
    }
    if (payloadBytes(plugin.elements) + payloadBytes(parsed.elements) > MESSAGING_BOUNDS.maxTotalPayloadBytes) {
      throw new MessagingError(
        'VALIDATION',
        `message would exceed ${MESSAGING_BOUNDS.maxTotalPayloadBytes} total payload bytes`,
      );
    }

    const existingIds = new Set(plugin.elements.map((el) => el.elementId));
    const stamped = stampAppendedElements(parsed, plugin, existingIds);
    // The TTL lock can be taken over after a predecessor persisted its message
    // revision but before it emitted the matching event. Treat appendOps as a
    // tiny durable outbox: a successor repairs every committed predecessor in
    // revision order before it is allowed to persist its own revision.
    const reconciled = await this.output.reconcile(msg, plugin, undefined, lease);
    const currentMessage = reconciled.message;
    const currentPlugin = reconciled.plugin;
    if (currentPlugin.revision !== plugin.revision) {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'append lease was superseded while output was reconciled');
    }
    const newRevision = currentPlugin.revision + 1;

    const updated: PluginMessageExtra = {
      ...currentPlugin,
      revision: newRevision,
      elements: [...currentPlugin.elements, ...stamped],
      appendOps: [
        ...currentPlugin.appendOps,
        {
          operationId: parsed.operationId,
          elementIds: stamped.map((el) => el.elementId),
          ...(parsed.baseRevision !== undefined ? { baseRevision: parsed.baseRevision } : {}),
        },
      ],
    };
    const written = await this.deps.messageStore.updatePluginMessage(
      currentMessage.id,
      updated as unknown as NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>,
      currentPlugin.revision,
    );
    if (!written) {
      const current = await this.deps.messageStore.getById(messageId);
      if (current) {
        throw new MessagingError('CONFLICT', 'message revision changed while the append lock lease was held');
      }
      throw new MessagingError('NOT_FOUND', `message ${messageId} disappeared during append`);
    }

    const writtenPlugin = readPluginMessageExtra(written);
    if (!writtenPlugin) throw new MessagingError('VALIDATION', 'persisted append lost its canonical plugin payload');
    const output = await this.output.emitRevision(written, writtenPlugin, newRevision, lease);
    return this.makeReceipt(output.message, newRevision, stamped, output.sequence);
  }

  private async requirePluginMessage(
    ctx: PluginCallContext,
    messageId: string,
  ): Promise<{ readonly msg: StoredMessage; readonly plugin: PluginMessageExtra }> {
    const msg = await this.deps.messageStore.getById(messageId);
    if (!msg || msg.deletedAt !== undefined || msg._tombstone) {
      throw new MessagingError('NOT_FOUND', `message ${messageId} not found`);
    }
    const plugin = readPluginMessageExtra(msg);
    if (!plugin) {
      throw new MessagingError('PERMISSION', 'appendElements targets a non-plugin message');
    }
    if (plugin.instanceId !== ctx.pluginInstanceId) {
      throw new MessagingError('PERMISSION', 'message belongs to a different plugin instance (INV-8)');
    }
    return { msg, plugin };
  }

  /** INV-12 replay guard inside the lock: write landed, settle crashed. */
  private async replayAppliedOperation(
    msg: StoredMessage,
    plugin: PluginMessageExtra,
    parsed: AppendElementsRequest,
    lease: AppendLease,
  ): Promise<AppendReceipt | null> {
    const replayIndex = plugin.appendOps.findIndex((op) => op.operationId === parsed.operationId);
    if (replayIndex < 0) return null;
    const record = plugin.appendOps[replayIndex] as AppendOpRecord;
    const retryIds = parsed.elements.map((element) => element.elementId);
    if (!sameIdSet(retryIds, record.elementIds)) {
      throw new MessagingError('VALIDATION', 'operationId was already applied with a different element set', {
        operationId: parsed.operationId,
      });
    }
    const reconciled = await this.output.reconcile(msg, plugin, parsed.operationId, lease);
    const persisted = reconciled.plugin.elements.filter((element) => record.elementIds.includes(element.elementId));
    return this.makeReceipt(
      reconciled.message,
      replayIndex + 2,
      persisted,
      reconciled.sequenceByOperation.get(parsed.operationId),
    );
  }

  /** Assemble a receipt only from persisted stamped elements and an emitted sequence. */
  private makeReceipt(
    msg: StoredMessage,
    revision: number,
    elements: readonly MessageElement[],
    appendSequence: number | undefined,
  ): AppendReceipt {
    return {
      messageId: msg.id,
      revision,
      ...(appendSequence !== undefined ? { appendSequence } : {}),
      appliedElementIds: elements.map((el) => el.elementId),
    };
  }
}
