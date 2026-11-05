import { randomUUID } from 'node:crypto';

/** The existing bounded, ephemeral window capabilities; no durable data or execution authority lives here. */
export class HomeWindowCapabilities {
  private readonly clients = new Map<
    string,
    { ownerUserId: string; clientToken: string; expiresAt: number; socketId?: string }
  >();

  constructor(private readonly isConnected?: (ownerUserId: string, socketId: string) => boolean) {}

  register(ownerUserId: string, clientId: string, socketId?: string) {
    for (const [id, client] of this.clients)
      if (
        client.expiresAt <= Date.now() &&
        (!client.socketId || !this.isConnected?.(client.ownerUserId, client.socketId))
      )
        this.clients.delete(id);
    if (this.clients.size >= 32 && !this.clients.has(clientId)) throw new Error('Home window capacity');
    const client = { ownerUserId, clientToken: randomUUID(), expiresAt: Date.now() + 8 * 60 * 60 * 1_000, socketId };
    this.clients.set(clientId, client);
    return { clientToken: client.clientToken, expiresAt: client.expiresAt };
  }

  owns(ownerUserId: string, clientId: string, clientToken: string): boolean {
    const client = this.clients.get(clientId);
    return Boolean(
      client &&
        client.ownerUserId === ownerUserId &&
        client.clientToken === clientToken &&
        client.expiresAt > Date.now() &&
        (!client.socketId || !this.isConnected || this.isConnected(ownerUserId, client.socketId)),
    );
  }

  unregister(ownerUserId: string, clientId: string, clientToken: string): boolean {
    const client = this.clients.get(clientId);
    // Exact owner cleanup remains valid after expiry; this grants no operation or renewal authority.
    if (!client || client.ownerUserId !== ownerUserId || client.clientToken !== clientToken) return false;
    this.clients.delete(clientId);
    return true;
  }

  connections(ownerUserId: string, clientId?: string): string[] {
    return [...this.clients].flatMap(([id, client]) =>
      client.ownerUserId === ownerUserId &&
      // Discovery can ask a still-bound socket to renew over owner HTTP; execution requires a live token.
      (clientId === undefined || client.expiresAt > Date.now()) &&
      client.socketId &&
      (!this.isConnected || this.isConnected(ownerUserId, client.socketId)) &&
      (!clientId || clientId === id)
        ? [client.socketId]
        : [],
    );
  }

  clear(): void {
    this.clients.clear();
  }
}
