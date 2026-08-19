import type { ExplicitStopIntent, ExplicitStopSourceControl } from '@cat-cafe/shared';

export type { ExplicitStopGesture, ExplicitStopIntent, ExplicitStopSourceControl } from '@cat-cafe/shared';

export interface ExplicitCancelInput {
  threadId: string;
  catId?: string;
  clientInstanceId: string;
  actionId: string;
  intent: ExplicitStopIntent;
}

interface VolatileCancelSocket {
  connected: boolean;
  volatile: {
    emit(event: 'cancel_invocation', payload: Record<string, unknown>): unknown;
  };
}

export function newCancelIdentity(prefix: 'client' | 'action'): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }

  // randomUUID() may be hidden on insecure HTTP origins, while getRandomValues()
  // remains available and supplies the same cryptographically strong entropy.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  const uuid = [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
  return `${prefix}-${uuid}`;
}

export function createExplicitStopIntent(
  event: { readonly isTrusted: boolean; readonly detail: number },
  sourceControl: ExplicitStopSourceControl,
): ExplicitStopIntent {
  return {
    sourceControl,
    gesture: event.detail === 0 ? 'keyboard' : 'pointer',
    trustedGesture: event.isTrusted,
  };
}

/** Socket.IO queues ordinary emit() calls while disconnected; volatile emit does not. */
export function emitExplicitCancel(socket: VolatileCancelSocket | null, input: ExplicitCancelInput): boolean {
  if (!socket?.connected || !input.intent.trustedGesture) return false;
  socket.volatile.emit('cancel_invocation', {
    threadId: input.threadId,
    ...(input.catId ? { catId: input.catId } : {}),
    origin: 'explicit_stop',
    actionId: input.actionId,
    clientInstanceId: input.clientInstanceId,
    sourceControl: input.intent.sourceControl,
    gesture: input.intent.gesture,
    trustedGesture: input.intent.trustedGesture,
  });
  return true;
}
