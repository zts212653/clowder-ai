/**
 * Plugin Messaging — host-issued address handles (K-1 / F288, AC-2, §4c)
 *
 * Handles are the ONLY addressing channel for drafts — schema-level there is
 * no bare-threadId path (§3.1). A handle binds pluginInstance + grant scope +
 * thread at issuance; the scope is the grant projection (K-2 control plane
 * takes over the issuance entry point; the mechanics live here).
 *
 * Lifecycle owner for HandleRecord state (§4c): this service. Revocation
 * cascades to subscriptions via CursorStore.revokeByHandle.
 */

import { randomUUID } from 'node:crypto';
import type { MessageAddress, MessageHandle } from '@clowder-ai/plugin-contract';
import type { HandleScope } from './contract/host-types.js';
import { MessagingError } from './contract/host-types.js';
import type {
  AddressHandleRecord,
  CursorStore,
  HandleRecord,
  HandleStore,
  MessageHandleRecord,
} from './stores/ports.js';

export interface IssueThreadHandleInput {
  readonly pluginInstanceId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly scope: HandleScope;
}

export interface IssueConnectorBindingHandleInput extends IssueThreadHandleInput {
  readonly connectorId: string;
  readonly externalChatId: string;
}

export class HandleService {
  private readonly handles: HandleStore;
  private readonly cursors: CursorStore;

  constructor(handles: HandleStore, cursors: CursorStore) {
    this.handles = handles;
    this.cursors = cursors;
  }

  async issueThreadHandle(input: IssueThreadHandleInput): Promise<{ handleId: string }> {
    const record: HandleRecord = {
      handleId: `th_${randomUUID()}`,
      kind: 'thread_handle',
      pluginInstanceId: input.pluginInstanceId,
      threadId: input.threadId,
      userId: input.userId,
      scope: input.scope,
      issuedAt: Date.now(),
    };
    await this.handles.put(record);
    return { handleId: record.handleId };
  }

  async issueConnectorBindingHandle(input: IssueConnectorBindingHandleInput): Promise<{ handleId: string }> {
    const record: HandleRecord = {
      handleId: `cb_${randomUUID()}`,
      kind: 'connector_binding',
      pluginInstanceId: input.pluginInstanceId,
      threadId: input.threadId,
      userId: input.userId,
      scope: input.scope,
      connectorBinding: { connectorId: input.connectorId, externalChatId: input.externalChatId },
      issuedAt: Date.now(),
    };
    await this.handles.put(record);
    return { handleId: record.handleId };
  }

  /** Common gate: existence → instance binding (INV-8) → liveness. */
  private async resolveLive(pluginInstanceId: string, handleId: string): Promise<HandleRecord> {
    const record = await this.handles.get(handleId);
    if (!record) throw new MessagingError('NOT_FOUND', `unknown handle ${handleId}`);
    if (record.pluginInstanceId !== pluginInstanceId) {
      throw new MessagingError('PERMISSION', 'handle is not bound to the calling plugin instance (INV-8)');
    }
    if (record.revokedAt !== undefined) {
      throw new MessagingError('PERMISSION', 'handle has been revoked (INV-8)');
    }
    return record;
  }

  async resolveForSend(pluginInstanceId: string, address: MessageAddress): Promise<AddressHandleRecord> {
    const record = await this.resolveLive(pluginInstanceId, address.handle);
    if (record.kind !== address.kind) {
      throw new MessagingError('VALIDATION', `address kind ${address.kind} does not match handle kind ${record.kind}`);
    }
    if (!record.scope.canSend) {
      throw new MessagingError('PERMISSION', 'handle scope does not grant send');
    }
    return record as AddressHandleRecord;
  }

  async resolveForSubscribe(pluginInstanceId: string, handleId: string): Promise<AddressHandleRecord> {
    const record = await this.resolveLive(pluginInstanceId, handleId);
    if (record.kind === 'message_handle') {
      throw new MessagingError('VALIDATION', 'message handles cannot authorize subscriptions');
    }
    if (!record.scope.canSubscribe) {
      throw new MessagingError('PERMISSION', 'handle scope does not grant subscribe');
    }
    return record;
  }

  /**
   * Send mints a host-opaque message capability before returning its receipt.
   * The token is a random `mh_` prefixed id — distinct from and not derivable
   * from the messageId (#1165 contract). The store's `getOrCreateMessageHandle`
   * provides atomicity: concurrent callers converge on one canonical record
   * (Memory: synchronous critical section; Redis: Lua script). A retry after
   * crash or claim expiry finds the existing handle and returns it without
   * creating an orphan.
   */
  async ensureMessageHandle(parent: AddressHandleRecord, messageId: string): Promise<MessageHandleRecord> {
    const candidate: MessageHandleRecord = {
      handleId: `mh_${randomUUID()}`,
      kind: 'message_handle',
      pluginInstanceId: parent.pluginInstanceId,
      threadId: parent.threadId,
      userId: parent.userId,
      scope: parent.scope,
      messageId,
      parentHandleId: parent.handleId,
      issuedAt: Date.now(),
    };
    let result: { record: MessageHandleRecord; created: boolean };
    try {
      result = await this.handles.getOrCreateMessageHandle(candidate);
    } catch (err) {
      // INV-21: store-level binding/corruption errors → application CONFLICT
      if (err instanceof Error && !(err instanceof MessagingError)) {
        const msg = err.message;
        if (msg.startsWith('handle index corruption') || msg.startsWith('handle binding violation')) {
          throw new MessagingError('CONFLICT', msg);
        }
      }
      throw err;
    }
    // Defense-in-depth: redundant after INV-21 store-level validation,
    // but kept as a safety net in case a store impl is swapped.
    if (!result.created) {
      if (
        result.record.pluginInstanceId !== parent.pluginInstanceId ||
        result.record.parentHandleId !== parent.handleId
      ) {
        throw new MessagingError('CONFLICT', 'message handle is already bound to different authority');
      }
    }
    return result.record;
  }

  /** Message capability + its parent address capability must both be live. */
  async resolveForAppend(pluginInstanceId: string, handle: MessageHandle): Promise<MessageHandleRecord> {
    const record = await this.resolveLive(pluginInstanceId, handle.token);
    if (record.kind !== 'message_handle') {
      throw new MessagingError('VALIDATION', 'handle token is not a message handle');
    }
    const parent = await this.resolveLive(pluginInstanceId, record.parentHandleId);
    if (parent.kind === 'message_handle' || parent.threadId !== record.threadId) {
      throw new MessagingError('PERMISSION', 'message handle parent authority is invalid');
    }
    if (!parent.scope.canSubscribe) {
      throw new MessagingError('PERMISSION', 'message handle parent scope does not grant append subscription');
    }
    return record;
  }

  /** active → revoked (idempotent); cascades to subscriptions (§4c). */
  async revoke(handleId: string): Promise<void> {
    const revokedAt = Date.now();
    await this.handles.revoke(handleId, revokedAt);
    await this.cursors.revokeByHandle(handleId, revokedAt);
  }
}
