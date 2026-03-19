import type { ConnectorThreadBinding } from '@cat-cafe/shared';

export interface IConnectorThreadBindingStore {
  bind(
    connectorId: string,
    externalChatId: string,
    threadId: string,
    userId: string,
  ): ConnectorThreadBinding | Promise<ConnectorThreadBinding>;
  getByExternal(
    connectorId: string,
    externalChatId: string,
  ): ConnectorThreadBinding | null | Promise<ConnectorThreadBinding | null>;
  getByThread(threadId: string): ConnectorThreadBinding[] | Promise<ConnectorThreadBinding[]>;
  remove(connectorId: string, externalChatId: string): boolean | Promise<boolean>;
  listByUser(
    connectorId: string,
    userId: string,
    limit?: number,
  ): ConnectorThreadBinding[] | Promise<ConnectorThreadBinding[]>;
  setHubThread(
    connectorId: string,
    externalChatId: string,
    hubThreadId: string,
  ): ConnectorThreadBinding | null | Promise<ConnectorThreadBinding | null>;
}

export class MemoryConnectorThreadBindingStore implements IConnectorThreadBindingStore {
  private readonly bindings = new Map<string, ConnectorThreadBinding>();

  private key(connectorId: string, externalChatId: string): string {
    return `${connectorId}:${externalChatId}`;
  }

  bind(connectorId: string, externalChatId: string, threadId: string, userId: string): ConnectorThreadBinding {
    const binding: ConnectorThreadBinding = {
      connectorId,
      externalChatId,
      threadId,
      userId,
      createdAt: Date.now(),
    };
    this.bindings.set(this.key(connectorId, externalChatId), binding);
    return binding;
  }

  getByExternal(connectorId: string, externalChatId: string): ConnectorThreadBinding | null {
    return this.bindings.get(this.key(connectorId, externalChatId)) ?? null;
  }

  getByThread(threadId: string): ConnectorThreadBinding[] {
    return [...this.bindings.values()].filter((b) => b.threadId === threadId);
  }

  remove(connectorId: string, externalChatId: string): boolean {
    return this.bindings.delete(this.key(connectorId, externalChatId));
  }

  listByUser(connectorId: string, userId: string, limit?: number): ConnectorThreadBinding[] {
    const all = [...this.bindings.values()].filter((b) => b.connectorId === connectorId && b.userId === userId);
    return limit ? all.slice(0, limit) : all;
  }

  setHubThread(connectorId: string, externalChatId: string, hubThreadId: string): ConnectorThreadBinding | null {
    const existing = this.bindings.get(this.key(connectorId, externalChatId));
    if (!existing) return null;
    const updated = { ...existing, hubThreadId };
    this.bindings.set(this.key(connectorId, externalChatId), updated);
    return updated;
  }
}
