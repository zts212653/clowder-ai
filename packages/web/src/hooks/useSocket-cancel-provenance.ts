export interface ExplicitCancelInput {
  threadId: string;
  catId?: string;
  clientInstanceId: string;
  actionId: string;
}

interface VolatileCancelSocket {
  connected: boolean;
  volatile: {
    emit(event: 'cancel_invocation', payload: Record<string, unknown>): unknown;
  };
}

export function newCancelIdentity(prefix: 'client' | 'action'): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

/** Socket.IO queues ordinary emit() calls while disconnected; volatile emit does not. */
export function emitExplicitCancel(socket: VolatileCancelSocket | null, input: ExplicitCancelInput): boolean {
  if (!socket?.connected) return false;
  socket.volatile.emit('cancel_invocation', {
    threadId: input.threadId,
    ...(input.catId ? { catId: input.catId } : {}),
    origin: 'explicit_stop',
    actionId: input.actionId,
    clientInstanceId: input.clientInstanceId,
  });
  return true;
}
