import type { AcpPermissionDispatcher, AcpPermissionHandler } from '../acp-permission-dispatcher.js';
import type { AcpAgentRequest, AcpNotification, AcpRequestId, AcpResponse } from '../types.js';
import { ACP_METHODS } from '../types.js';
import { isAcpRecord } from './acp-capabilities.js';

export type AcpPacket =
  | { kind: 'response'; response: AcpResponse }
  | { kind: 'request'; request: AcpAgentRequest }
  | { kind: 'notification'; notification: AcpNotification }
  | { kind: 'invalid' };

export function isAcpRequestId(value: unknown): value is AcpRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
/** Preserve the raw envelope and ID type. Unknown fields do not become supported methods. */
export function classifyAcpPacket(value: unknown): AcpPacket {
  if (!isAcpRecord(value) || value.jsonrpc !== '2.0') return { kind: 'invalid' };
  if (typeof value.method === 'string') {
    if (value.params !== undefined && !isAcpRecord(value.params)) return { kind: 'invalid' };
    const packet = value.params === undefined ? { ...value, params: {} } : value;
    if (value.id === undefined) return { kind: 'notification', notification: packet as unknown as AcpNotification };
    if (isAcpRequestId(value.id)) return { kind: 'request', request: packet as unknown as AcpAgentRequest };
    return { kind: 'invalid' };
  }
  if (!isAcpRequestId(value.id)) return { kind: 'invalid' };
  if (value.error != null && value.result !== undefined) return { kind: 'invalid' };
  if (
    value.error != null &&
    (!isAcpRecord(value.error) || typeof value.error.code !== 'number' || typeof value.error.message !== 'string')
  )
    return { kind: 'invalid' };
  if (value.result === undefined && value.error == null) return { kind: 'invalid' };
  return { kind: 'response', response: value as unknown as AcpResponse };
}

/** Resolve an approval at delivery time so a later cancellation cannot send stale selected. */
export async function prepareAcpAgentReply(
  request: AcpAgentRequest,
  permissions: AcpPermissionDispatcher,
  handler?: AcpPermissionHandler,
  signal?: AbortSignal,
): Promise<(() => AcpResponse) | null> {
  if (request.method !== ACP_METHODS.requestPermission)
    return () => ({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Client does not handle ${request.method}` },
    });
  const pending = permissions.dispatch(request, handler, signal);
  if (!pending) return null;
  const delivery = await pending;
  return () => ({ jsonrpc: '2.0', id: request.id, result: delivery.resolveOutcome() });
}
